import { GUARDS_METADATA } from '@nestjs/common/constants';
import { CustomerLoanController, AdminLoanController } from './loan.controller';
import { SuperadminSessionGuard } from '../auth/session.guard';

describe('loan approval controller access', () => {
  it('requires the Superadmin session guard for Admin approval routes', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, AdminLoanController) as unknown[];
    expect(guards).toContain(SuperadminSessionGuard);
  });

  it('does not expose a customer offer-acceptance route', () => {
    expect('acceptOffer' in CustomerLoanController.prototype).toBe(false);
  });
});
