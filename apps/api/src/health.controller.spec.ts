import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';
import type { PrismaService } from './prisma/prisma.service';

describe('HealthController', () => {
  it('reports process health without depending on the database', () => {
    const controller = new HealthController({} as PrismaService);

    expect(controller.getHealth()).toEqual({ status: 'ok' });
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
