import { BadRequestException, ConflictException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { LOAN_PROCESSING_FEE_KES } from '../payments/processing-fee.constants';
import { DEFAULT_WEBSITE_CONTENT } from './website-content';
import { WebsiteService } from './website.service';

describe('WebsiteService', () => {
  it('returns only the published revision to public visitors and falls back to safe defaults', async () => {
    const findFirst = jest.fn(async () => null);
    const service = new WebsiteService({
      websiteContentRevision: { findFirst },
    } as unknown as PrismaService);

    await expect(service.getPublished()).resolves.toEqual({
      content: DEFAULT_WEBSITE_CONTENT,
      version: 0,
      publishedAt: null,
      processingFeeKes: LOAN_PROCESSING_FEE_KES,
    });
    expect(findFirst).toHaveBeenCalledWith({ where: { status: 'PUBLISHED' } });
  });

  it('serves published content but never draft content to public reads', async () => {
    const published = { version: 4, status: 'PUBLISHED', content: DEFAULT_WEBSITE_CONTENT, publishedAt: new Date() };
    const findFirst = jest.fn(async ({ where }: { where: { status: string } }) => where.status === 'PUBLISHED' ? published : null);
    const service = new WebsiteService({ websiteContentRevision: { findFirst } } as unknown as PrismaService);

    const result = await service.getPublished();

    expect(result.version).toBe(4);
    expect(result.content).toEqual(DEFAULT_WEBSITE_CONTENT);
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst).toHaveBeenCalledWith({ where: { status: 'PUBLISHED' } });
  });

  it('rejects stale draft writes instead of overwriting another administrator edit', async () => {
    const updateMany = jest.fn(async () => ({ count: 0 }));
    const tx = {
      websiteContentRevision: {
        findFirst: jest.fn(async () => ({ id: 'draft-id', version: 8, status: 'DRAFT' })),
        updateMany,
      },
      adminAuditLog: { create: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as PrismaService;
    const service = new WebsiteService(prisma);

    await expect(service.saveDraft(DEFAULT_WEBSITE_CONTENT, 8, 'admin-id')).rejects.toBeInstanceOf(ConflictException);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'draft-id', status: 'DRAFT', version: 8 },
    }));
  });

  it('publishes atomically and records the publication administrator', async () => {
    const updateMany = jest.fn(async () => ({ count: 1 }));
    const audit = jest.fn(async () => ({}));
    const tx = {
      websiteContentRevision: {
        findFirst: jest.fn(async () => ({ id: 'draft-id', version: 5, status: 'DRAFT', content: DEFAULT_WEBSITE_CONTENT })),
        updateMany,
      },
      adminAuditLog: { create: audit },
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as PrismaService;
    const service = new WebsiteService(prisma);

    await expect(service.publishDraft(5, 'admin-id', '127.0.0.1')).resolves.toMatchObject({ version: 5, content: DEFAULT_WEBSITE_CONTENT });
    expect(updateMany).toHaveBeenNthCalledWith(1, { where: { status: 'PUBLISHED' }, data: { status: 'ARCHIVED' } });
    expect(updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { id: 'draft-id', version: 5, status: 'DRAFT' },
      data: expect.objectContaining({ status: 'PUBLISHED', publishedById: 'admin-id' }),
    }));
    expect(audit).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'WEBSITE_CONTENT_PUBLISH', superadminId: 'admin-id' }) });
  });

  it('reads the authoritative fixed processing-fee amount and ignores website content', async () => {
    const service = new WebsiteService({
      websiteContentRevision: {
        findFirst: jest.fn(async () => null),
      },
    } as unknown as PrismaService);
    const result = await service.getPublished();
    expect(result.processingFeeKes).toBe(50);
    expect(result.processingFeeKes).toBe(LOAN_PROCESSING_FEE_KES);
  });

  it('rejects image payloads whose declared format does not match their bytes', async () => {
    const service = new WebsiteService({} as PrismaService);
    await expect(service.saveImage('data:image/png;base64,SGVsbG8=', 'image/png'))
      .rejects.toBeInstanceOf(BadRequestException);
  });
});
