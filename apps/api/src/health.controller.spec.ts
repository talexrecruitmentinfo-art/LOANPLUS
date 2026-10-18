import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';
import type { PrismaService } from './prisma/prisma.service';

describe('HealthController', () => {
  const originalRelease = process.env.APP_RELEASE_SHA;
  const originalRenderCommit = process.env.RENDER_GIT_COMMIT;

  afterEach(() => {
    if (originalRelease === undefined) delete process.env.APP_RELEASE_SHA;
    else process.env.APP_RELEASE_SHA = originalRelease;
    if (originalRenderCommit === undefined) delete process.env.RENDER_GIT_COMMIT;
    else process.env.RENDER_GIT_COMMIT = originalRenderCommit;
  });

  it('reports process health without depending on the database', () => {
    const controller = new HealthController({} as PrismaService);

    expect(controller.getHealth()).toEqual({ status: 'ok' });
  });

  it('returns the validated configured release and never returns unrelated environment data', () => {
    process.env.APP_RELEASE_SHA = 'a'.repeat(40);
    process.env.RENDER_GIT_COMMIT = 'b'.repeat(40);
    const controller = new HealthController({} as PrismaService);

    expect(controller.getVersion()).toEqual({ releaseId: 'a'.repeat(40), source: 'configured' });
    expect(JSON.stringify(controller.getVersion())).not.toContain('RENDER_GIT_COMMIT');
  });

  it('uses Render commit metadata when no explicit release is configured', () => {
    delete process.env.APP_RELEASE_SHA;
    process.env.RENDER_GIT_COMMIT = 'abc1234';
    const controller = new HealthController({} as PrismaService);

    expect(controller.getVersion()).toEqual({ releaseId: 'abc1234', source: 'render' });
  });

  it('returns unknown when no valid release identifier is available', () => {
    delete process.env.APP_RELEASE_SHA;
    delete process.env.RENDER_GIT_COMMIT;
    const controller = new HealthController({} as PrismaService);

    expect(controller.getVersion()).toEqual({ releaseId: 'unknown', source: 'unknown' });
  });

  it('reports readiness after a minimal database query', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    const controller = new HealthController(prisma as unknown as PrismaService);

    await expect(controller.getReadiness()).resolves.toEqual({ status: 'ok' });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('returns a generic unavailable response when the database query fails', async () => {
    const prisma = { $queryRaw: jest.fn().mockRejectedValue(new Error('sensitive database details')) };
    const controller = new HealthController(prisma as unknown as PrismaService);
    const result = await controller.getReadiness().catch((error: unknown) => error);

    expect(result).toBeInstanceOf(ServiceUnavailableException);
    if (!(result instanceof ServiceUnavailableException)) throw result;
    expect(result.getResponse()).toEqual({ status: 'unavailable' });
  });
});
