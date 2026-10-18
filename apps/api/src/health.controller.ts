import { Controller, Get, Header, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';

const READINESS_PROBE_TIMEOUT_MS = 3_000;

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  getHealth(): { status: string } {
    return { status: 'ok' };
  }

  getVersion(): { releaseId: string; source: 'configured' | 'render' | 'unknown' } {
    const configuredRelease = process.env.APP_RELEASE_SHA;
    const renderRelease = process.env.RENDER_GIT_COMMIT;
    const candidate = [
      { releaseId: configuredRelease, source: 'configured' as const },
      { releaseId: renderRelease, source: 'render' as const },
    ].find((release) => release.releaseId && /^[a-f0-9]{7,40}$/i.test(release.releaseId));
    if (!candidate) {
      return { releaseId: 'unknown', source: 'unknown' };
    }
    return { releaseId: candidate.releaseId!, source: candidate.source };
  }

  @Get('ready')
  async getReadiness(): Promise<{ status: string }> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      const timedOut = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('READINESS_PROBE_TIMEOUT')), READINESS_PROBE_TIMEOUT_MS);
      });
      await Promise.race([
        this.prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT 1`;
          },
          { maxWait: READINESS_PROBE_TIMEOUT_MS, timeout: READINESS_PROBE_TIMEOUT_MS },
        ),
        timedOut,
      ]);
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException({ status: 'unavailable' });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  @Get('version')
  @Header('Cache-Control', 'no-store, max-age=0')
  getReleaseVersion() {
    return this.getVersion();
  }
}