import { ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { AuthenticatedRequest } from '../auth/request.types';
import { SuperadminSessionGuard } from '../auth/session.guard';
import type { PlatformSettingsService } from './platform-settings.service';
import { AdminPlatformSettingsController } from './platform-settings.controller';

describe('AdminPlatformSettingsController wallet-deposit configuration', () => {
  const settings = {
    getWalletDepositConfiguration: jest.fn(),
    updateWalletDepositConfiguration: jest.fn(),
  };
  const controller = new AdminPlatformSettingsController(settings as unknown as PlatformSettingsService);

  beforeEach(() => jest.clearAllMocks());

  it('protects configuration reads and writes with the Superadmin session guard', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, AdminPlatformSettingsController) as unknown[];
    expect(guards).toContain(SuperadminSessionGuard);
  });

  it('returns current configuration and invokes audited updates with the authenticated actor', async () => {
    settings.getWalletDepositConfiguration.mockResolvedValue({ ready: false });
    settings.updateWalletDepositConfiguration.mockResolvedValue({ ready: true });
    const request = {
      principal: { id: 'superadmin-id', role: 'SUPERADMIN' },
      ip: '127.0.0.1',
      headers: { origin: new URL(process.env.WEB_ORIGIN ?? 'http://localhost:3000').origin },
    } as unknown as AuthenticatedRequest;
    const dto = {
      minimumAmountKes: 100,
      maximumAmountKes: 20_000,
      productApproved: false,
      customerWalletLiabilityAccountCode: 'CUSTOMER_WALLET_LIABILITY',
      mpesaClearingAccountCode: 'MPESA_CLEARING',
      reason: 'Configure approved deposit limits',
    };

    await expect(controller.getWalletDepositConfiguration()).resolves.toEqual({ data: { ready: false } });
    await expect(controller.updateWalletDepositConfiguration(dto, request))
      .resolves.toEqual({ data: { ready: true } });
    expect(settings.updateWalletDepositConfiguration).toHaveBeenCalledWith(dto, 'superadmin-id', '127.0.0.1');
  });

  it('rejects wallet configuration writes without a same-origin browser request', async () => {
    const request = {
      principal: { id: 'superadmin-id', role: 'SUPERADMIN' },
      headers: { origin: 'https://attacker.example' },
    } as unknown as AuthenticatedRequest;
    await expect(controller.updateWalletDepositConfiguration({
      minimumAmountKes: 100,
      maximumAmountKes: 200,
      productApproved: false,
      customerWalletLiabilityAccountCode: 'CUSTOMER_WALLET_LIABILITY',
      mpesaClearingAccountCode: 'MPESA_CLEARING',
      reason: 'Configure approved deposit limits',
    }, request)).rejects.toBeInstanceOf(ForbiddenException);
    expect(settings.updateWalletDepositConfiguration).not.toHaveBeenCalled();
  });
});
