import {
  BadRequestException, ConflictException, Injectable, NotFoundException,
} from '@nestjs/common';
import { Prisma, WebsiteContentRevision } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { LOAN_PROCESSING_FEE_KES } from '../payments/processing-fee.constants';
import { DEFAULT_WEBSITE_CONTENT, validateWebsiteContent } from './website-content';

const ALLOWED_FORMATS = [
  { extension: '.png', mime: 'image/png', matches: (bytes: Buffer) => bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  { extension: '.jpg', mime: 'image/jpeg', matches: (bytes: Buffer) => bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9 },
  { extension: '.webp', mime: 'image/webp', matches: (bytes: Buffer) => bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' },
];

@Injectable()
export class WebsiteService {
  constructor(private readonly prisma: PrismaService) {}

  async getPublished() {
    const revision = await this.prisma.websiteContentRevision.findFirst({ where: { status: 'PUBLISHED' } });
    return {
      content: revision ? validateWebsiteContent(revision.content) : DEFAULT_WEBSITE_CONTENT,
      version: revision?.version ?? 0,
      publishedAt: revision?.publishedAt ?? null,
      processingFeeKes: LOAN_PROCESSING_FEE_KES,
    };
  }

  async getDraft() {
    const [draft, published] = await Promise.all([
      this.prisma.websiteContentRevision.findFirst({
        where: { status: 'DRAFT' },
        include: { createdBy: { select: { email: true } } },
      }),
      this.prisma.websiteContentRevision.findFirst({
        where: { status: 'PUBLISHED' },
        select: { version: true, publishedAt: true, publishedBy: { select: { email: true } } },
      }),
    ]);
    return {
      draft: draft ? this.presentRevision(draft) : null,
      published: published ? {
        version: published.version,
        publishedAt: published.publishedAt,
        publishedBy: published.publishedBy?.email ?? null,
      } : null,
      processingFeeKes: LOAN_PROCESSING_FEE_KES,
    };
  }

  async saveDraft(contentInput: unknown, expectedVersion: number, adminId: string, ipAddress?: string) {
    const content = validateWebsiteContent(contentInput);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.websiteContentRevision.findFirst({ where: { status: 'DRAFT' } });
        let revision: WebsiteContentRevision;
        if (existing) {
          if (existing.version !== expectedVersion) throw new ConflictException('The draft changed in another session. Refresh before saving.');
          const updated = await tx.websiteContentRevision.updateMany({
            where: { id: existing.id, status: 'DRAFT', version: expectedVersion },
            data: { content: content as unknown as Prisma.InputJsonValue, version: { increment: 1 }, createdById: adminId },
          });
          if (updated.count !== 1) throw new ConflictException('The draft changed in another session. Refresh before saving.');
          revision = await tx.websiteContentRevision.findUniqueOrThrow({ where: { id: existing.id } });
        } else {
          if (expectedVersion !== 0) throw new ConflictException('No matching draft exists. Refresh before saving.');
          const latest = await tx.websiteContentRevision.findFirst({ orderBy: { version: 'desc' }, select: { version: true } });
          revision = await tx.websiteContentRevision.create({
            data: { version: (latest?.version ?? 0) + 1, status: 'DRAFT', content: content as unknown as Prisma.InputJsonValue, createdById: adminId },
          });
        }
        await tx.adminAuditLog.create({
          data: { superadminId: adminId, action: 'WEBSITE_DRAFT_SAVE', subjectType: 'WEBSITE_CONTENT', subjectId: revision.id, outcome: 'SUCCESS', ipAddress: ipAddress?.slice(0, 64) },
        });
        return this.presentRevision(revision);
      });
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Another administrator changed the website draft. Refresh before saving.');
      }
      throw error;
    }
  }

  async publishDraft(expectedVersion: number, adminId: string, ipAddress?: string) {
    return this.prisma.$transaction(async (tx) => {
      const draft = await tx.websiteContentRevision.findFirst({ where: { status: 'DRAFT' } });
      if (!draft || draft.version !== expectedVersion) throw new ConflictException('The draft changed or no draft is available to publish.');
      const content = validateWebsiteContent(draft.content);
      await tx.websiteContentRevision.updateMany({
        where: { status: 'PUBLISHED' },
        data: { status: 'ARCHIVED' },
      });
      const changed = await tx.websiteContentRevision.updateMany({
        where: { id: draft.id, version: expectedVersion, status: 'DRAFT' },
        data: { status: 'PUBLISHED', publishedAt: new Date(), publishedById: adminId, content: content as unknown as Prisma.InputJsonValue },
      });
      if (changed.count !== 1) throw new ConflictException('The draft changed while publishing. Refresh and try again.');
      await tx.adminAuditLog.create({
        data: { superadminId: adminId, action: 'WEBSITE_CONTENT_PUBLISH', subjectType: 'WEBSITE_CONTENT', subjectId: draft.id, outcome: 'SUCCESS', ipAddress: ipAddress?.slice(0, 64) },
      });
      return { version: draft.version, publishedAt: new Date(), content };
    });
  }

  async discardDraft(adminId: string, ipAddress?: string) {
    return this.prisma.$transaction(async (tx) => {
      const draft = await tx.websiteContentRevision.findFirst({ where: { status: 'DRAFT' } });
      if (!draft) return { discarded: false };
      await tx.websiteContentRevision.delete({ where: { id: draft.id } });
      await tx.adminAuditLog.create({
        data: { superadminId: adminId, action: 'WEBSITE_DRAFT_DISCARD', subjectType: 'WEBSITE_CONTENT', subjectId: draft.id, outcome: 'SUCCESS', ipAddress: ipAddress?.slice(0, 64) },
      });
      return { discarded: true };
    });
  }

  async getHistory() {
    const revisions = await this.prisma.websiteContentRevision.findMany({
      where: { status: { in: ['PUBLISHED', 'ARCHIVED'] } },
      orderBy: { version: 'desc' },
      take: 20,
      include: {
        createdBy: { select: { email: true } },
        publishedBy: { select: { email: true } },
      },
    });
    return revisions.map((revision) => ({
      version: revision.version,
      status: revision.status,
      createdAt: revision.createdAt,
      createdBy: revision.createdBy.email,
      publishedAt: revision.publishedAt,
      publishedBy: revision.publishedBy?.email ?? null,
    }));
  }

  async saveImage(data: string, declaredMime: string) {
    if (typeof data !== 'string' || data.length > 7_000_000) {
      throw new BadRequestException('Image is too large. Maximum image size is 5 MB.');
    }
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
    if (!match || match[1] !== declaredMime) throw new BadRequestException('Choose a PNG, JPEG or WebP image.');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length === 0 || bytes.length > 5 * 1024 * 1024) throw new BadRequestException('Image must be no larger than 5 MB.');
    const format = ALLOWED_FORMATS.find((candidate) => candidate.mime === declaredMime && candidate.matches(bytes));
    if (!format) throw new BadRequestException('The image content does not match a supported image format.');
    const filename = `${randomUUID()}${format.extension}`;
    const directory = process.env.WEBSITE_ASSET_DIR ?? join(process.cwd(), 'uploads', 'website');
    await mkdir(directory, { recursive: true, mode: 0o750 });
    await writeFile(join(directory, filename), bytes, { flag: 'wx', mode: 0o640 });
    return { url: `/api/v1/platform/website/assets/${filename}`, mimeType: format.mime };
  }

  async readImage(filename: string) {
    if (!/^[a-f0-9-]{36}\.(png|jpg|webp)$/i.test(filename) || extname(filename) !== `.${filename.split('.').at(-1)}`) {
      throw new NotFoundException('Image asset not found.');
    }
    const directory = process.env.WEBSITE_ASSET_DIR ?? join(process.cwd(), 'uploads', 'website');
    try {
      const bytes = await readFile(join(directory, filename));
      const format = ALLOWED_FORMATS.find((candidate) => candidate.matches(bytes));
      if (!format) throw new NotFoundException('Image asset not found.');
      return { bytes, mimeType: format.mime };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        throw new NotFoundException('Image asset not found.');
      }
      throw error;
    }
  }

  private presentRevision(revision: WebsiteContentRevision & { createdBy?: { email: string } }) {
    return {
      id: revision.id,
      version: revision.version,
      updatedAt: revision.updatedAt,
      updatedBy: revision.createdBy?.email,
      content: validateWebsiteContent(revision.content),
    };
  }
}
