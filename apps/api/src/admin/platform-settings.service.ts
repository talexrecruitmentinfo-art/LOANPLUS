import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CUSTOMER_WALLET_LIABILITY_ACCOUNT_CODE,
  MAX_WALLET_DEPOSIT_AMOUNT_KES,
  MPESA_CLEARING_ACCOUNT_CODE,
  WALLET_DEPOSIT_SETTING_KEY,
} from '../payments/wallet-deposit.config';

const CURRENCY_SETTING_KEY = 'platform.currency.display';
const INSTALL_SETTING_KEY = 'platform.pwa.installation';
const RECONCILIATION_SETTING_KEY = 'payments.reconciliation.pending_minutes';

const DEFAULT_CURRENCY = {
  code: 'KES',
  name: 'Kenyan Shilling',
  symbol: 'KSh',
  locale: 'en-KE',
  decimalPlaces: 0,
  transactionCurrency: 'KES',
  supportedCurrencies: ['KES'],
} as const;

export interface SettingRecord {
  enabled: boolean;
  updatedAt: Date | null;
  updatedById: string | null;
  updatedByEmail: string | null;
}

export interface ReconciliationThresholdRecord {
  pendingThresholdMinutes: number;
  updatedAt: Date | null;
  updatedById: string | null;
  updatedByEmail: string | null;
}

export interface WalletDepositConfiguration {
  minimumAmountKes: number | null;
  maximumAmountKes: number | null;
  productApproved: boolean;
  approvalReference: string | null;
  approvalEvidence: string | null;
  customerWalletLiabilityAccountCode: string;
  mpesaClearingAccountCode: string;
  configurationReason: string | null;
  updatedAt: Date | null;
  updatedById: string | null;
  updatedByEmail: string | null;
  ready: boolean;
  unavailableReasons: string[];
  history: Array<{
    id: string;
    actorId: string | null;
    actorEmail: string | null;
    createdAt: Date;
    reason: string | null;
    changedFields: string[];
    before: Prisma.JsonValue | null;
    after: Prisma.JsonValue | null;
  }>;
}

@Injectable()
export class PlatformSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async getCurrencySettings() {
    const setting = await this.prisma.systemSetting.findUnique({
      where: { key: CURRENCY_SETTING_KEY },
      include: { updatedBy: { select: { email: true } } },
    });
    return {
      ...DEFAULT_CURRENCY,
      updatedAt: setting?.updatedAt ?? null,
      updatedById: setting?.updatedById ?? null,
      updatedByEmail: setting?.updatedBy?.email ?? null,
    };
  }

  async updateCurrencySettings(currencyCode: string, reason: string, superadminId: string, ipAddress?: string) {
    const auditReason = this.validateReason(reason);
    if (currencyCode !== 'KES') {
      throw new UnprocessableEntityException(
        'Only KES is supported by the current wallet, ledger, activation and M-Pesa accounting workflows.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const previous = await tx.systemSetting.findUnique({
        where: { key: CURRENCY_SETTING_KEY },
        select: { value: true },
      });
      await tx.systemSetting.upsert({
        where: { key: CURRENCY_SETTING_KEY },
        create: {
          key: CURRENCY_SETTING_KEY,
          value: { code: 'KES' },
          updatedById: superadminId,
        },
        update: { value: { code: 'KES' }, updatedById: superadminId },
      });
      await tx.adminAuditLog.create({
        data: {
          superadminId,
          action: 'PLATFORM_CURRENCY_UPDATE',
          subjectType: 'SYSTEM_SETTING',
          subjectId: CURRENCY_SETTING_KEY,
          outcome: 'SUCCESS',
          reason: auditReason,
          details: { before: { currency: previous ? 'KES' : 'default KES' }, after: { currency: 'KES' } },
          ipAddress: ipAddress?.slice(0, 64),
        },
      });
    });

    return this.getCurrencySettings();
  }

  async getInstallPolicy(): Promise<SettingRecord> {
    const setting = await this.prisma.systemSetting.findUnique({
      where: { key: INSTALL_SETTING_KEY },
      include: { updatedBy: { select: { email: true } } },
    });
    const value = setting?.value;
    const enabled =
      value && typeof value === 'object' && !Array.isArray(value) && 'enabled' in value &&
      typeof value.enabled === 'boolean'
        ? value.enabled
        : true;
      return {
        enabled,
        updatedAt: setting?.updatedAt ?? null,
        updatedById: setting?.updatedById ?? null,
        updatedByEmail: setting?.updatedBy?.email ?? null,
    };
  }

  async getCustomerInstallEligibility() {
    const policy = await this.getInstallPolicy();
    return {
      eligible: policy.enabled,
      reason: policy.enabled ? null : 'App installation is currently unavailable for this account.',
    };
  }

  async updateInstallPolicy(enabled: boolean, reason: string, superadminId: string, ipAddress?: string) {
    const auditReason = this.validateReason(reason);
    await this.prisma.$transaction(async (tx) => {
      const previous = await tx.systemSetting.findUnique({
        where: { key: INSTALL_SETTING_KEY },
        select: { value: true },
      });
      const previousEnabled = previous?.value && typeof previous.value === 'object' &&
        !Array.isArray(previous.value) && 'enabled' in previous.value &&
        typeof previous.value.enabled === 'boolean'
        ? previous.value.enabled
        : true;
      await tx.systemSetting.upsert({
        where: { key: INSTALL_SETTING_KEY },
        create: {
          key: INSTALL_SETTING_KEY,
          value: { enabled } as Prisma.InputJsonValue,
          updatedById: superadminId,
        },
        update: { value: { enabled } as Prisma.InputJsonValue, updatedById: superadminId },
      });
      await tx.adminAuditLog.create({
        data: {
          superadminId,
          action: 'PWA_INSTALL_POLICY_UPDATE',
          subjectType: 'SYSTEM_SETTING',
          subjectId: INSTALL_SETTING_KEY,
          outcome: 'SUCCESS',
          reason: auditReason,
          details: { before: { enabled: previousEnabled }, after: { enabled } },
          ipAddress: ipAddress?.slice(0, 64),
        },
      });
    });
    return this.getInstallPolicy();
  }

  async getReconciliationThreshold(): Promise<ReconciliationThresholdRecord> {
    const setting = await this.prisma.systemSetting.findUnique({
      where: { key: RECONCILIATION_SETTING_KEY },
      include: { updatedBy: { select: { email: true } } },
    });
    const configured = typeof setting?.value === 'number' ? setting.value : 5;
    const pendingThresholdMinutes = Number.isInteger(configured) && configured >= 1 && configured <= 1440
      ? configured
      : 5;
    return {
      pendingThresholdMinutes,
      updatedAt: setting?.updatedAt ?? null,
      updatedById: setting?.updatedById ?? null,
      updatedByEmail: setting?.updatedBy?.email ?? null,
    };
  }

  async getWalletDepositConfiguration(): Promise<WalletDepositConfiguration> {
    const [setting, liability, clearing, history] = await Promise.all([
      this.prisma.systemSetting.findUnique({
        where: { key: WALLET_DEPOSIT_SETTING_KEY },
        include: { updatedBy: { select: { email: true } } },
      }),
      this.prisma.ledgerAccount.findUnique({
        where: { code: CUSTOMER_WALLET_LIABILITY_ACCOUNT_CODE },
        select: { isActive: true, currency: true, accountType: true },
      }),
      this.prisma.ledgerAccount.findUnique({
        where: { code: MPESA_CLEARING_ACCOUNT_CODE },
        select: { isActive: true, currency: true, accountType: true },
      }),
      this.prisma.adminAuditLog.findMany({
        where: { subjectType: 'SYSTEM_SETTING', subjectId: WALLET_DEPOSIT_SETTING_KEY },
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: { superadmin: { select: { email: true } } },
      }),
    ]);
    const value = setting?.value;
    const record = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, Prisma.JsonValue>
      : {};
    const minimumAmountKes = this.validStoredDepositAmount(record.minimumAmountKes) ? record.minimumAmountKes : null;
    const maximumAmountKes = this.validStoredDepositAmount(record.maximumAmountKes) ? record.maximumAmountKes : null;
    const productApproved = record.productApproved === true &&
      typeof record.approvalReference === 'string' && record.approvalReference.trim().length > 0;
    const unavailableReasons: string[] = [];
    if (minimumAmountKes === null || maximumAmountKes === null || minimumAmountKes > maximumAmountKes) {
      unavailableReasons.push('Approved wallet-deposit limits are not configured.');
    }
    if (!productApproved) {
      unavailableReasons.push('Wallet deposits are awaiting verified Safaricom production-product approval.');
    }
    if (!liability?.isActive || liability.currency !== 'KES' || liability.accountType !== 'LIABILITY') {
      unavailableReasons.push('The required active KES customer-wallet liability account is unavailable.');
    }
    if (!clearing?.isActive || clearing.currency !== 'KES' || clearing.accountType !== 'ASSET') {
      unavailableReasons.push('The required active KES M-Pesa clearing account is unavailable.');
    }
    return {
      minimumAmountKes,
      maximumAmountKes,
      productApproved,
      approvalReference: typeof record.approvalReference === 'string' ? record.approvalReference : null,
      approvalEvidence: typeof record.approvalEvidence === 'string' ? record.approvalEvidence : null,
      customerWalletLiabilityAccountCode: CUSTOMER_WALLET_LIABILITY_ACCOUNT_CODE,
      mpesaClearingAccountCode: MPESA_CLEARING_ACCOUNT_CODE,
      configurationReason: typeof record.configurationReason === 'string' ? record.configurationReason : null,
      updatedAt: setting?.updatedAt ?? null,
      updatedById: setting?.updatedById ?? null,
      updatedByEmail: setting?.updatedBy?.email ?? null,
      ready: unavailableReasons.length === 0,
      unavailableReasons,
      history: history.map((event) => {
        const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
          ? event.details as Record<string, Prisma.JsonValue>
          : {};
        return {
          id: event.id,
          actorId: event.superadminId,
          actorEmail: event.superadmin?.email ?? null,
          createdAt: event.createdAt,
          reason: event.reason,
          changedFields: Array.isArray(details.changedFields)
            ? details.changedFields.filter((field): field is string => typeof field === 'string')
            : [],
          before: details.before ?? null,
          after: details.after ?? null,
        };
      }),
    };
  }

  async updateWalletDepositConfiguration(
    input: {
      minimumAmountKes: number;
      maximumAmountKes: number;
      productApproved: boolean;
      approvalReference?: string;
      approvalEvidence?: string;
      customerWalletLiabilityAccountCode: string;
      mpesaClearingAccountCode: string;
      reason: string;
    },
    superadminId: string,
    ipAddress?: string,
  ): Promise<WalletDepositConfiguration> {
    const reason = this.validateReason(input.reason);
    if (!this.validStoredDepositAmount(input.minimumAmountKes) ||
      !this.validStoredDepositAmount(input.maximumAmountKes) ||
      input.minimumAmountKes > input.maximumAmountKes) {
      throw new UnprocessableEntityException(
        'Wallet deposit limits must be positive whole-KSh amounts and the minimum must not exceed the maximum.',
      );
    }
    if (input.customerWalletLiabilityAccountCode !== CUSTOMER_WALLET_LIABILITY_ACCOUNT_CODE ||
      input.mpesaClearingAccountCode !== MPESA_CLEARING_ACCOUNT_CODE) {
      throw new UnprocessableEntityException('Wallet deposits must use the designated customer-wallet liability and M-Pesa clearing accounts.');
    }
    if (input.productApproved &&
      (!input.approvalReference?.trim() || input.approvalReference.trim().length > 120)) {
      throw new UnprocessableEntityException('A verified Safaricom production approval reference is required before enabling wallet deposits.');
    }
    if (input.approvalEvidence && input.approvalEvidence.trim().length > 500) {
      throw new UnprocessableEntityException('Approval evidence must not exceed 500 characters.');
    }

    const [liability, clearing] = await Promise.all([
      this.prisma.ledgerAccount.findUnique({
        where: { code: CUSTOMER_WALLET_LIABILITY_ACCOUNT_CODE },
        select: { isActive: true, currency: true, accountType: true },
      }),
      this.prisma.ledgerAccount.findUnique({
        where: { code: MPESA_CLEARING_ACCOUNT_CODE },
        select: { isActive: true, currency: true, accountType: true },
      }),
    ]);
    if (!liability?.isActive || liability.currency !== 'KES' || liability.accountType !== 'LIABILITY') {
      throw new UnprocessableEntityException('An active KES CUSTOMER_WALLET_LIABILITY liability account is required.');
    }
    if (!clearing?.isActive || clearing.currency !== 'KES' || clearing.accountType !== 'ASSET') {
      throw new UnprocessableEntityException('An active KES MPESA_CLEARING asset account is required.');
    }

    const next: Record<string, Prisma.JsonValue> = {
      minimumAmountKes: input.minimumAmountKes,
      maximumAmountKes: input.maximumAmountKes,
      productApproved: input.productApproved,
      approvalReference: input.productApproved ? input.approvalReference!.trim() : null,
      approvalEvidence: input.productApproved ? input.approvalEvidence?.trim() || null : null,
      customerWalletLiabilityAccountCode: CUSTOMER_WALLET_LIABILITY_ACCOUNT_CODE,
      mpesaClearingAccountCode: MPESA_CLEARING_ACCOUNT_CODE,
      configurationReason: reason,
    };
    await this.prisma.$transaction(async (tx) => {
      const previousSetting = await tx.systemSetting.findUnique({
        where: { key: WALLET_DEPOSIT_SETTING_KEY },
        select: { value: true },
      });
      const previous = previousSetting?.value && typeof previousSetting.value === 'object' &&
        !Array.isArray(previousSetting.value)
        ? previousSetting.value as Record<string, Prisma.JsonValue>
        : {};
      const changedFields = Object.keys(next).filter((field) =>
        JSON.stringify(previous[field] ?? null) !== JSON.stringify(next[field] ?? null));
      await tx.systemSetting.upsert({
        where: { key: WALLET_DEPOSIT_SETTING_KEY },
        create: {
          key: WALLET_DEPOSIT_SETTING_KEY,
          value: next as Prisma.InputJsonValue,
          updatedById: superadminId,
        },
        update: { value: next as Prisma.InputJsonValue, updatedById: superadminId },
      });
      await tx.adminAuditLog.create({
        data: {
          superadminId,
          action: 'WALLET_DEPOSIT_CONFIGURATION_UPDATE',
          subjectType: 'SYSTEM_SETTING',
          subjectId: WALLET_DEPOSIT_SETTING_KEY,
          outcome: 'SUCCESS',
          reason,
          details: {
            changedFields,
            before: previous as Prisma.InputJsonValue,
            after: next as Prisma.InputJsonValue,
          },
          ipAddress: ipAddress?.slice(0, 64),
        },
      });
    });
    return this.getWalletDepositConfiguration();
  }

  async updateReconciliationThreshold(
    pendingThresholdMinutes: number,
    reason: string,
    superadminId: string,
    ipAddress?: string,
  ) {
    const auditReason = this.validateReason(reason);
    if (!Number.isInteger(pendingThresholdMinutes) || pendingThresholdMinutes < 1 || pendingThresholdMinutes > 1440) {
      throw new UnprocessableEntityException('The reconciliation pending threshold must be between 1 and 1440 minutes.');
    }
    await this.prisma.$transaction(async (tx) => {
      const previous = await tx.systemSetting.findUnique({
        where: { key: RECONCILIATION_SETTING_KEY },
        select: { value: true },
      });
      const previousMinutes = typeof previous?.value === 'number' &&
        Number.isInteger(previous.value) && previous.value >= 1 && previous.value <= 1440
        ? previous.value
        : 5;
      await tx.systemSetting.upsert({
        where: { key: RECONCILIATION_SETTING_KEY },
        create: { key: RECONCILIATION_SETTING_KEY, value: pendingThresholdMinutes, updatedById: superadminId },
        update: { value: pendingThresholdMinutes, updatedById: superadminId },
      });
      await tx.adminAuditLog.create({
        data: {
          superadminId,
          action: 'PAYMENT_RECONCILIATION_THRESHOLD_UPDATE',
          subjectType: 'SYSTEM_SETTING',
          subjectId: RECONCILIATION_SETTING_KEY,
          outcome: 'SUCCESS',
          reason: auditReason,
          details: {
            before: { pendingThresholdMinutes: previousMinutes },
            after: { pendingThresholdMinutes },
          },
          ipAddress: ipAddress?.slice(0, 64),
        },
      });
    });
    return this.getReconciliationThreshold();
  }

  private validateReason(reason: string): string {
    const trimmed = reason.trim();
    if (trimmed.length < 10 || trimmed.length > 500) {
      throw new UnprocessableEntityException('A settings change reason must be 10 to 500 non-whitespace characters.');
    }
    return trimmed;
  }

  private validStoredDepositAmount(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 &&
      value <= MAX_WALLET_DEPOSIT_AMOUNT_KES;
  }
}