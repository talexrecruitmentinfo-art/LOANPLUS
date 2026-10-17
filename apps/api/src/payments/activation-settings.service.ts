import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigureActivationDto } from './payment.dto';

@Injectable()
export class ActivationSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async getSettings() {
    const [amount, policy] = await Promise.all([
      this.prisma.systemSetting.findUnique({ where: { key: 'activation.amount_kes' } }),
      this.prisma.systemSetting.findUnique({ where: { key: 'activation.payment_policy' } }),
    ]);
    return { amountKes: amount?.value ?? null, policy: policy?.value ?? null };
  }

  async configure(dto: ConfigureActivationDto, superadminId: string, ipAddress?: string) {
    if (dto.approved && process.env.ACTIVATION_POLICY_APPROVAL_ENVIRONMENT !== 'staging') {
      throw new UnprocessableEntityException('Activation policy approval is enabled only for the explicitly configured staging environment.');
    }
    if (dto.amountKes !== 50) {
      throw new UnprocessableEntityException('Account activation amount must be exactly KES 50.');
    }
    if (dto.approved && /^draft(?:[-_. ]|$)/i.test(dto.termsVersion.trim())) {
      throw new UnprocessableEntityException('Draft activation terms cannot be approved.');
    }
    if (dto.approved && !dto.creditedToWallet && !dto.creditAccountCode) {
      throw new UnprocessableEntityException('An approved accounting credit account is required.');
    }
    if (dto.approved) {
      const accountCodes = [
        'MPESA_CLEARING',
        ...(dto.creditedToWallet ? [] : [dto.creditAccountCode!]),
      ];
      const accounts = await this.prisma.ledgerAccount.findMany({
        where: { code: { in: accountCodes }, isActive: true, currency: 'KES' },
        select: { code: true, accountType: true },
      });
      const clearing = accounts.find((account) => account.code === 'MPESA_CLEARING');
      const credit = accounts.find((account) => account.code === dto.creditAccountCode);
      if (
        accounts.length !== accountCodes.length ||
        clearing?.accountType !== 'ASSET' ||
        (!dto.creditedToWallet && !['LIABILITY', 'REVENUE'].includes(credit?.accountType ?? ''))
      ) {
        throw new UnprocessableEntityException('Required active KES ledger accounts are not configured.');
      }
    }

    const policy = {
      approved: dto.approved,
      purpose: dto.purpose.trim(),
      refundability: dto.refundability,
      creditedToWallet: dto.creditedToWallet,
      accountingTreatment: dto.accountingTreatment.trim(),
      customerDisclosure: dto.customerDisclosure.trim(),
      termsVersion: dto.termsVersion.trim(),
      creditAccountCode: dto.creditedToWallet ? null : dto.creditAccountCode?.trim() ?? null,
    };
    await this.prisma.$transaction(async (tx) => {
      await tx.systemSetting.upsert({
        where: { key: 'activation.amount_kes' },
        create: { key: 'activation.amount_kes', value: dto.amountKes, updatedById: superadminId },
        update: { value: dto.amountKes, updatedById: superadminId },
      });
      await tx.systemSetting.upsert({
        where: { key: 'activation.payment_policy' },
        create: { key: 'activation.payment_policy', value: policy as Prisma.InputJsonValue, updatedById: superadminId },
        update: { value: policy as Prisma.InputJsonValue, updatedById: superadminId },
      });
      await tx.adminAuditLog.create({
        data: {
          superadminId,
          action: 'ACTIVATION_POLICY_UPDATE',
          subjectType: 'SYSTEM_SETTING',
          subjectId: 'activation',
          outcome: 'SUCCESS',
          reason: dto.reason.trim(),
          ipAddress: ipAddress?.slice(0, 64),
        },
      });
    });
    return { amountKes: dto.amountKes, policy };
  }
}