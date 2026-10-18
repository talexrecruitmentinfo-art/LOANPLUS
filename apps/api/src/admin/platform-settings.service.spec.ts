import { UnprocessableEntityException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { PlatformSettingsService } from './platform-settings.service';

describe('PlatformSettingsService', () => {
  it('defaults to KES display and transaction currency without a database setting', async () => {
    const service = new PlatformSettingsService({
      systemSetting: { findUnique: jest.fn(async () => null) },
    } as unknown as PrismaService);

    await expect(service.getCurrencySettings()).resolves.toMatchObject({
      code: 'KES',
      name: 'Kenyan Shilling',
      symbol: 'KSh',
      locale: 'en-KE',
      decimalPlaces: 0,
      transactionCurrency: 'KES',
      supportedCurrencies: ['KES'],
    });
  });

  it('rejects unsupported display currencies before touching storage', async () => {
    const upsert = jest.fn();
    const service = new PlatformSettingsService({
      systemSetting: { findUnique: jest.fn() },
      $transaction: jest.fn(),
    } as unknown as PrismaService);

    await expect(service.updateCurrencySettings('USD', 'Approved request', 'admin-id'))
      .rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('persists supported settings and audits the administrator and reason transactionally', async () => {
    const upsert = jest.fn(async () => ({}));
    const audit = jest.fn(async () => ({}));
    const tx = { systemSetting: { upsert }, adminAuditLog: { create: audit } };
    const setting = {
      value: { enabled: false, code: 'KES' },
      updatedAt: new Date('2026-10-18T00:00:00Z'),
      updatedById: 'admin-id',
      updatedBy: { email: 'admin@example.invalid' },
    };
    const prisma = {
      systemSetting: { findUnique: jest.fn(async () => setting) },
      $transaction: jest.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as PrismaService;
    const service = new PlatformSettingsService(prisma);

    await service.updateCurrencySettings('KES', 'Confirm KES display policy', 'admin-id', '127.0.0.1');
    await service.updateInstallPolicy(false, 'Disable install entry temporarily', 'admin-id', '127.0.0.1');
    await service.updateReconciliationThreshold(10, 'Queue older pending payments at ten minutes', 'admin-id', '127.0.0.1');

    expect(upsert).toHaveBeenCalledTimes(3);
    expect(audit).toHaveBeenNthCalledWith(1, { data: expect.objectContaining({
      superadminId: 'admin-id',
      action: 'PLATFORM_CURRENCY_UPDATE',
      reason: 'Confirm KES display policy',
      ipAddress: '127.0.0.1',
    }) });
    expect(audit).toHaveBeenNthCalledWith(2, { data: expect.objectContaining({
      superadminId: 'admin-id',
      action: 'PWA_INSTALL_POLICY_UPDATE',
      reason: 'Disable install entry temporarily',
    }) });
    expect(audit).toHaveBeenNthCalledWith(3, { data: expect.objectContaining({
      superadminId: 'admin-id',
      action: 'PAYMENT_RECONCILIATION_THRESHOLD_UPDATE',
      reason: 'Queue older pending payments at ten minutes',
    }) });
  });

  it('defaults reconciliation age threshold to five minutes', async () => {
    const service = new PlatformSettingsService({
      systemSetting: { findUnique: jest.fn(async () => null) },
    } as unknown as PrismaService);

    await expect(service.getReconciliationThreshold()).resolves.toMatchObject({ pendingThresholdMinutes: 5 });
  });

  it('defaults global PWA installation to enabled and reads persisted policy', async () => {
    const findUnique = jest.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        value: { enabled: false },
        updatedAt: new Date('2026-10-18T00:00:00Z'),
        updatedById: 'admin-id',
      });
    const service = new PlatformSettingsService({
      systemSetting: { findUnique },
    } as unknown as PrismaService);

    await expect(service.getInstallPolicy()).resolves.toMatchObject({ enabled: true, updatedById: null });
    await expect(service.getCustomerInstallEligibility()).resolves.toMatchObject({
      eligible: false,
      reason: 'App installation is currently unavailable for this account.',
    });
  });
});