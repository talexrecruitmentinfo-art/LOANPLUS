import { Controller, Get, Header, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';

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
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException({ status: 'unavailable' });
    }
  }

  @Get('version')
  @Header('Cache-Control', 'no-store, max-age=0')
  getReleaseVersion() {
    return this.getVersion();
  }
}