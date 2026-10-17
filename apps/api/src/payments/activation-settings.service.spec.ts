import { UnprocessableEntityException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { ActivationSettingsService } from './activation-settings.service';
import type { ConfigureActivationDto } from './payment.dto';

describe('ActivationSettingsService', () => {
  const upsert = jest.fn();
  const adminAuditCreate = jest.fn();
  const transaction = jest.fn(async (callback: (tx: never) => Promise<unknown>) => callback({
    systemSetting: { upsert },
    adminAuditLog: { create: adminAuditCreate },
  } as never));
  const service = new ActivationSettingsService({
    $transaction: transaction,
    ledgerAccount: { findMany: jest.fn(async () => [
      { code: 'MPESA_CLEARING', accountType: 'ASSET' },
      { code: 'ACTIVATION_FEES', accountType: 'REVENUE' },
    ]) },
  } as unknown as PrismaService);

  const configured = (overrides: Partial<ConfigureActivationDto> = {}) => ({
    amountKes: 50,
    approved: true,
    purpose: 'Account activation only',
    refundability: 'CONDITIONAL_REFUND' as const,
    creditedToWallet: false,
    accountingTreatment: 'Credit activation fee revenue',
    customerDisclosure: 'This payment activates the account only.',
    termsVersion: 'activation-v1',
    creditAccountCode: 'ACTIVATION_FEES',
    reason: 'Configure approved activation policy',
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ACTIVATION_POLICY_APPROVAL_ENVIRONMENT = 'staging';
  });

  afterEach(() => {
    delete process.env.ACTIVATION_POLICY_APPROVAL_ENVIRONMENT;
  });

  it('refuses policy approval unless the environment is explicitly staging', async () => {
    delete process.env.ACTIVATION_POLICY_APPROVAL_ENVIRONMENT;
    await expect(service.configure(configured(), 'admin-id'))
      .rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects activation prices other than KES 50', async () => {
    await expect(service.configure(configured({ amountKes: 49 }), 'admin-id'))
      .rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each(['draft-v1', 'DRAFT', 'draft_v2', 'draft policy'])(
    'rejects an approved activation policy with draft version %s',
    async (termsVersion) => {
      await expect(service.configure(configured({ termsVersion }), 'admin-id'))
        .rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  it('allows storing a draft only while explicitly unapproved', async () => {
    await service.configure(configured({ approved: false, termsVersion: 'draft-v1' }), 'admin-id');
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(2);
  });
});
