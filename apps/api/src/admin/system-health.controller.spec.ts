import { BadRequestException } from '@nestjs/common';
import { SystemHealthService } from './system-health.service';
import { AdminSystemHealthController } from './system-health.controller';

describe('AdminSystemHealthController', () => {
  const health = { getDashboard: jest.fn() };
  const controller = new AdminSystemHealthController(health as unknown as SystemHealthService);

  beforeEach(() => jest.clearAllMocks());

  it('validates and forwards incident search filters and server pagination', async () => {
    health.getDashboard.mockResolvedValue({ incidents: [], incidentPagination: { total: 0 } });

    await controller.getDashboard('database', 'CRITICAL', 'OPEN', '2', '25');

    expect(health.getDashboard).toHaveBeenCalledWith({
      search: 'database',
      severity: 'CRITICAL',
      status: 'OPEN',
      page: 2,
      pageSize: 25,
    });
  });

  it('rejects invalid page sizes and unsupported incident states', async () => {
    await expect(controller.getDashboard(undefined, undefined, undefined, '0')).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.getDashboard(undefined, 'TRACE')).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.getDashboard(undefined, undefined, 'RECOVERING')).rejects.toBeInstanceOf(BadRequestException);
  });
});
