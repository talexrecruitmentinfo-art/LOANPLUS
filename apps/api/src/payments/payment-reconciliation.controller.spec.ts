import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import 'reflect-metadata';
import { SuperadminSessionGuard } from '../auth/session.guard';
import { PaymentReconciliationController } from './payment-reconciliation.controller';

describe('PaymentReconciliationController permissions', () => {
  it('allows finance staff to read the queue but keeps reconciliation mutations Superadmin-only', () => {
    expect(Reflect.getMetadata('staff-allowed-roles', PaymentReconciliationController.prototype.list))
      .toEqual(['STAFF_FINANCE']);
    for (const action of ['reconcile', 'verifyEvidence', 'escalate'] as const) {
      expect(Reflect.getMetadata('staff-allowed-roles', PaymentReconciliationController.prototype[action]))
        .toBeUndefined();
    }
  });

  it('rejects finance staff from reconciliation mutation endpoints', async () => {
    const prisma = {
      superadminSession: {
        findFirst: jest.fn(async () => ({
          superadmin: {
            id: 'finance-staff-id',
            role: 'STAFF_FINANCE',
            email: 'finance@example.test',
          },
        })),
      },
    };
    const request = { cookies: { lp_admin_session: 'session-token' } };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => PaymentReconciliationController.prototype.escalate,
    } as unknown as ExecutionContext;
    const guard = new SuperadminSessionGuard(prisma as never);

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
