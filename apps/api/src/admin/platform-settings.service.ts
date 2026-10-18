import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

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
}