import { UnprocessableEntityException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { PlatformSettingsService } from './platform-settings.service';
import {
  CUSTOMER_WALLET_LIABILITY_ACCOUNT_CODE,
  MPESA_CLEARING_ACCOUNT_CODE,
  WALLET_DEPOSIT_SETTING_KEY,
} from '../payments/wallet-deposit.config';

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
    const tx = {
      systemSetting: { upsert, findUnique: jest.fn(async () => null) },
      adminAuditLog: { create: audit },
    };
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

  it('keeps wallet deposits unavailable until persisted limits and verified approval exist', async () => {
    const service = new PlatformSettingsService({
      systemSetting: { findUnique: jest.fn(async () => null) },
      ledgerAccount: { findUnique: jest.fn(async ({ where }: { where: { code: string } }) => ({
        isActive: true,
        currency: 'KES',
        accountType: where.code === CUSTOMER_WALLET_LIABILITY_ACCOUNT_CODE ? 'LIABILITY' : 'ASSET',
      })) },
      adminAuditLog: { findMany: jest.fn(async () => []) },
    } as unknown as PrismaService);

    await expect(service.getWalletDepositConfiguration()).resolves.toMatchObject({
      minimumAmountKes: null,
      maximumAmountKes: null,
      productApproved: false,
      ready: false,
      unavailableReasons: expect.arrayContaining([
        'Approved wallet-deposit limits are not configured.',
        'Wallet deposits are awaiting verified Safaricom production-product approval.',
      ]),
    });
  });

  it.each([
    [0, 100],
    [100, 99],
    [1, 2_147_483_648],
    [10.5, 100],
  ])('rejects invalid wallet-deposit limits (%s, %s)', async (minimumAmountKes, maximumAmountKes) => {
    const service = new PlatformSettingsService({} as PrismaService);
    await expect(service.updateWalletDepositConfiguration({
      minimumAmountKes,
      maximumAmountKes,
      productApproved: false,
      customerWalletLiabilityAccountCode: CUSTOMER_WALLET_LIABILITY_ACCOUNT_CODE,
      mpesaClearingAccountCode: MPESA_CLEARING_ACCOUNT_CODE,
      reason: 'Approved business policy limit setup',
    }, 'admin-id')).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('requires a verified external approval reference before enabling customer deposits', async () => {
    const service = new PlatformSettingsService({} as PrismaService);
    await expect(service.updateWalletDepositConfiguration({
      minimumAmountKes: 100,
      maximumAmountKes: 20_000,
      productApproved: true,
      customerWalletLiabilityAccountCode: CUSTOMER_WALLET_LIABILITY_ACCOUNT_CODE,
      mpesaClearingAccountCode: MPESA_CLEARING_ACCOUNT_CODE,
      reason: 'External approval was reviewed',
    }, 'admin-id')).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('persists wallet limits and product approval with before/after audit details', async () => {
    const previous = {
      minimumAmountKes: 50,
      maximumAmountKes: 10_000,
      productApproved: false,
      approvalReference: null,
      approvalEvidence: null,
      customerWalletLiabilityAccountCode: CUSTOMER_WALLET_LIABILITY_ACCOUNT_CODE,
      mpesaClearingAccountCode: MPESA_CLEARING_ACCOUNT_CODE,
      configurationReason: 'Previous approved limits',
    };
    const stored = {
      value: {
        minimumAmountKes: 100,
        maximumAmountKes: 20_000,
        productApproved: true,
        approvalReference: 'SAFE-TEST-REFERENCE',
        approvalEvidence: 'External approval record reviewed',
        customerWalletLiabilityAccountCode: CUSTOMER_WALLET_LIABILITY_ACCOUNT_CODE,
        mpesaClearingAccountCode: MPESA_CLEARING_ACCOUNT_CODE,
        configurationReason: 'Reviewed verified approval evidence',
      },
      updatedAt: new Date('2026-10-20T10:00:00Z'),
      updatedById: 'admin-id',
      updatedBy: { email: 'admin@example.invalid' },
    };
    const upsert = jest.fn(async () => ({}));
    const audit = jest.fn(async () => ({}));
    const tx = {
      systemSetting: { findUnique: jest.fn(async () => ({ value: previous })), upsert },
      adminAuditLog: { create: audit },
    };
    const prisma = {
      systemSetting: { findUnique: jest.fn(async () => stored) },
      ledgerAccount: { findUnique: jest.fn(async ({ where }: { where: { code: string } }) => ({
        isActive: true,
        currency: 'KES',
        accountType: where.code === CUSTOMER_WALLET_LIABILITY_ACCOUNT_CODE ? 'LIABILITY' : 'ASSET',
      })) },
      adminAuditLog: {
        findMany: jest.fn(async () => [{
          id: 'audit-id',
          superadminId: 'admin-id',
          superadmin: { email: 'admin@example.invalid' },
          createdAt: new Date('2026-10-20T10:00:00Z'),
          reason: 'Reviewed verified approval evidence',
          details: {
            changedFields: ['minimumAmountKes', 'maximumAmountKes', 'productApproved'],
            before: previous,
            after: stored.value,
          },
        }]),
      },
      $transaction: jest.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as PrismaService;
    const service = new PlatformSettingsService(prisma);

    const result = await service.updateWalletDepositConfiguration({
      minimumAmountKes: 100,
      maximumAmountKes: 20_000,
      productApproved: true,
      approvalReference: 'SAFE-TEST-REFERENCE',
      approvalEvidence: 'External approval record reviewed',
      customerWalletLiabilityAccountCode: CUSTOMER_WALLET_LIABILITY_ACCOUNT_CODE,
      mpesaClearingAccountCode: MPESA_CLEARING_ACCOUNT_CODE,
      reason: 'Reviewed verified approval evidence',
    }, 'admin-id', '127.0.0.1');

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { key: WALLET_DEPOSIT_SETTING_KEY },
      create: expect.objectContaining({ updatedById: 'admin-id' }),
    }));
    expect(audit).toHaveBeenCalledWith({ data: expect.objectContaining({
      superadminId: 'admin-id',
      action: 'WALLET_DEPOSIT_CONFIGURATION_UPDATE',
      subjectId: WALLET_DEPOSIT_SETTING_KEY,
      reason: 'Reviewed verified approval evidence',
      ipAddress: '127.0.0.1',
      details: expect.objectContaining({
        changedFields: expect.arrayContaining(['minimumAmountKes', 'maximumAmountKes', 'productApproved']),
        before: previous,
        after: stored.value,
      }),
    }) });
    expect(result).toMatchObject({
      ready: true,
      updatedByEmail: 'admin@example.invalid',
      history: [{ actorEmail: 'admin@example.invalid', reason: 'Reviewed verified approval evidence' }],
    });
  });
});