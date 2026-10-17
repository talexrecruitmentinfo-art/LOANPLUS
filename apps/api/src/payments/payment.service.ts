import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { LedgerAccountType, PaymentStatus, PaymentType, Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  decryptSensitiveValue,
  encryptSensitiveValue,
  hashToken,
  normalizeKenyaPhone,
} from '../auth/security.util';
import { LedgerService } from '../ledger/ledger.service';
import { MpesaService } from './mpesa.service';
import { InitiateActivationPaymentDto } from './payment.dto';

interface ActivationPolicy {
  approved: boolean;
  purpose: string;
  refundability: 'REFUNDABLE' | 'NON_REFUNDABLE' | 'CONDITIONAL_REFUND';
  creditedToWallet: boolean;
  accountingTreatment: string;
  customerDisclosure: string;
  termsVersion: string;
  creditAccountCode: string | null;
}

interface MpesaCallback {
  CheckoutRequestID: string;
  MerchantRequestID: string;
  ResultCode: number;
  ResultDesc: string;
  CallbackMetadata?: { Item?: Array<{ Name: string; Value?: string | number }> };
}

@Injectable()
export class PaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mpesa: MpesaService,
    private readonly ledger: LedgerService,
  ) {}

  async getActivationTerms() {
    const [amount, setting] = await Promise.all([
      this.prisma.systemSetting.findUnique({ where: { key: 'activation.amount_kes' } }),
      this.prisma.systemSetting.findUnique({ where: { key: 'activation.payment_policy' } }),
    ]);
    const policy = this.parsePolicy(setting?.value);
    if (!policy?.approved || typeof amount?.value !== 'number') {
      return { available: false, amountKes: null, terms: null };
    }
    return {
      available: true,
      amountKes: amount.value,
      terms: {
        purpose: policy.purpose,
        refundability: policy.refundability,
        creditedToWallet: policy.creditedToWallet,
        customerDisclosure: policy.customerDisclosure,
        termsVersion: policy.termsVersion,
      },
    };
  }

  async initiateActivationPayment(
    userId: string,
    dto: InitiateActivationPaymentDto,
    idempotencyKey: string | undefined,
  ) {
    if (dto.termsAccepted !== true) throw new BadRequestException('Activation payment terms must be accepted.');
    if (!idempotencyKey || !/^[a-zA-Z0-9._:-]{16,128}$/.test(idempotencyKey)) {
      throw new BadRequestException('A valid Idempotency-Key header is required.');
    }
    const phoneNumber = normalizeKenyaPhone(dto.phoneNumber);
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ userId, phoneNumber }))
      .digest('hex');
    const scopedKey = `activation:${userId}:${idempotencyKey}`;
    const existing = await this.prisma.paymentTransaction.findUnique({ where: { idempotencyKey: scopedKey } });
    if (existing) {
      if (
        existing.userId !== userId ||
        existing.type !== PaymentType.ACTIVATION ||
        existing.requestHash !== requestHash
      ) {
        throw new ConflictException('The idempotency key has already been used.');
      }
      return { reference: existing.internalReference, status: existing.status, amountKes: existing.amountKes, currency: existing.currency };
    }

    const [user, amountSetting, policySetting] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { phone: true, isActive: true, activationStatus: true } }),
      this.prisma.systemSetting.findUnique({ where: { key: 'activation.amount_kes' } }),
      this.prisma.systemSetting.findUnique({ where: { key: 'activation.payment_policy' } }),
    ]);
    if (!user || !user.isActive) throw new ForbiddenException('This account cannot request activation.');
    if (user.activationStatus === 'ACTIVE') throw new ConflictException('This account is already activated.');
    const amountKes = typeof amountSetting?.value === 'number' ? amountSetting.value : 0;
    const policy = this.parsePolicy(policySetting?.value);
    if (!Number.isSafeInteger(amountKes) || amountKes < 1 || !policy?.approved) {
      throw new ServiceUnavailableException('Activation payment terms are not configured.');
    }

    const callbackToken = randomBytes(32).toString('base64url');
    const callbackUrl = this.makeCallbackUrl(callbackToken);
    this.mpesa.assertConfiguredForPayments();
    const payment = await this.prisma.$transaction(async (tx) => {
      const pending = await tx.paymentTransaction.findFirst({
        where: { userId, type: PaymentType.ACTIVATION, status: PaymentStatus.PENDING },
        select: { id: true },
      });
      if (pending) throw new ConflictException('An activation payment is already awaiting confirmation.');
      const created = await tx.paymentTransaction.create({
        data: {
          internalReference: `LPA${randomBytes(16).toString('hex').toUpperCase()}`,
          idempotencyKey: scopedKey,
          requestHash,
          userId,
          type: PaymentType.ACTIVATION,
          amountKes,
          activationRequest: {
            create: {
              userId,
              callbackTokenHash: hashToken(callbackToken),
              policySnapshot: policy as unknown as Prisma.InputJsonValue,
              phoneNumberCiphertext: encryptSensitiveValue(phoneNumber),
              expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            },
          },
        },
        include: { activationRequest: true },
      });
      await tx.idempotencyRecord.create({
        data: {
          scope: 'ACTIVATION_PAYMENT',
          key: scopedKey,
          userId,
          paymentTransactionId: created.id,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
      return created;
    });

    try {
      const providerRequest = await this.mpesa.initiateStkPush({
        amountKes,
        phoneNumber: phoneNumber.slice(1),
        accountReference: payment.internalReference.slice(-12),
        description: 'Activation',
        callbackUrl,
      });
      await this.prisma.activationPaymentRequest.update({
        where: { paymentTransactionId: payment.id },
        data: {
          checkoutRequestId: providerRequest.checkoutRequestId,
          merchantRequestId: providerRequest.merchantRequestId,
        },
      });
    } catch {
      await this.prisma.paymentTransaction.updateMany({
        where: { id: payment.id, status: PaymentStatus.PENDING },
        data: { failureCode: 'INITIATION_OUTCOME_UNCERTAIN' },
      });
      return {
        reference: payment.internalReference,
        status: PaymentStatus.PENDING,
        amountKes,
        currency: 'KES',
        message: 'The payment request outcome is being checked. Do not submit another payment; check this transaction status.',
      };
    }

    return {
      reference: payment.internalReference,
      status: PaymentStatus.PENDING,
      amountKes,
      currency: 'KES',
      message: 'Check your phone for the M-Pesa prompt. Activation is pending provider confirmation.',
    };
  }

  async listCustomerPayments(userId: string) {
    return this.prisma.paymentTransaction.findMany({
      where: { userId },
      select: {
        internalReference: true,
        type: true,
        amountKes: true,
        currency: true,
        status: true,
        providerReference: true,
        receiptReference: true,
        confirmedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async handleMpesaCallback(callbackToken: string, payload: unknown): Promise<{ ResultCode: number; ResultDesc: string }> {
    const callback = this.parseCallback(payload);
    const callbackTokenHash = hashToken(callbackToken);
    const request = await this.prisma.activationPaymentRequest.findUnique({
      where: { callbackTokenHash },
      include: { paymentTransaction: true },
    });
    if (!request || !request.checkoutRequestId || !request.merchantRequestId) {
      throw new NotFoundException('Payment callback is invalid.');
    }
    if (callback.CheckoutRequestID !== request.checkoutRequestId) {
      throw new ForbiddenException('Payment callback did not match the requested transaction.');
    }
    if (callback.MerchantRequestID !== request.merchantRequestId) {
      throw new ForbiddenException('Payment callback did not match the requested transaction.');
    }

    const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const priorEvent = await this.prisma.paymentCallbackEvent.findFirst({
      where: { activationPaymentRequestId: request.id, payloadHash },
      select: { id: true },
    });
    if (priorEvent) return { ResultCode: 0, ResultDesc: 'Accepted' };

    const providerStatus = await this.mpesa.queryStkStatus(request.checkoutRequestId);
    if (
      providerStatus.checkoutRequestId !== request.checkoutRequestId ||
      providerStatus.checkoutRequestId !== callback.CheckoutRequestID ||
      providerStatus.merchantRequestId !== request.merchantRequestId ||
      providerStatus.merchantRequestId !== callback.MerchantRequestID ||
      providerStatus.resultCode !== callback.ResultCode
    ) {
      throw new ServiceUnavailableException('M-Pesa callback could not be reconciled with provider status.');
    }
    const receiptValue = this.getCallbackItem(callback, 'MpesaReceiptNumber');
    const receipt = typeof receiptValue === 'string' ? receiptValue : null;
    const amount = this.getCallbackItem(callback, 'Amount');
    const isConfirmed = providerStatus.resultCode === 0;
    if (isConfirmed) {
      const phoneNumber = this.getCallbackItem(callback, 'PhoneNumber');
      if (
        request.paymentTransaction.currency !== 'KES' ||
        typeof amount !== 'number' ||
        !Number.isSafeInteger(amount) ||
        amount !== request.paymentTransaction.amountKes ||
        typeof receipt !== 'string' ||
        !/^[A-Za-z0-9]{6,32}$/.test(receipt) ||
        (typeof phoneNumber !== 'number' && typeof phoneNumber !== 'string')
      ) {
        throw new ServiceUnavailableException('M-Pesa confirmation did not match the requested payment.');
      }
      let expectedPhone: string;
      let confirmedPhone: string;
      try {
        if (!request.phoneNumberCiphertext) throw new Error('Payment phone number is unavailable.');
        expectedPhone = normalizeKenyaPhone(decryptSensitiveValue(request.phoneNumberCiphertext));
        confirmedPhone = normalizeKenyaPhone(String(phoneNumber));
      } catch {
        throw new ServiceUnavailableException('M-Pesa confirmation did not match the requested payment.');
      }
      if (expectedPhone !== confirmedPhone) {
        throw new ServiceUnavailableException('M-Pesa confirmation did not match the requested payment.');
      }
    }
    const now = new Date();
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.paymentCallbackEvent.create({
          data: {
            activationPaymentRequestId: request.id,
            paymentTransactionId: request.paymentTransactionId,
            payloadHash,
            providerResultCode: String(providerStatus.resultCode),
            providerReceiptReference: null,
          },
        });
        const changed = await tx.paymentTransaction.updateMany({
          where: { id: request.paymentTransactionId, status: PaymentStatus.PENDING },
          data: {
            status: isConfirmed ? PaymentStatus.CONFIRMED : PaymentStatus.FAILED,
            providerReference: request.checkoutRequestId,
            receiptReference: null,
            confirmedAt: isConfirmed ? now : null,
            failureCode: isConfirmed ? null : `MPESA_RESULT_${providerStatus.resultCode}`,
          },
        });
        if (changed.count === 0) {
          const current = await tx.paymentTransaction.findUniqueOrThrow({ where: { id: request.paymentTransactionId } });
          if (current.status === PaymentStatus.CONFIRMED && isConfirmed) return;
          if (current.status === PaymentStatus.FAILED && !isConfirmed) return;
          throw new ConflictException('Payment has already been reconciled.');
        }

        if (isConfirmed) {
          const policy = this.parsePolicy(request.policySnapshot ?? undefined);
          if (!policy?.approved) throw new ServiceUnavailableException('Activation accounting policy is unavailable.');
          const creditAccount = await this.getCreditAccount(tx, policy, request.paymentTransaction.userId);
          const clearingAccount = await tx.ledgerAccount.findUnique({ where: { code: 'MPESA_CLEARING' } });
          if (
            !clearingAccount ||
            !clearingAccount.isActive ||
            clearingAccount.currency !== 'KES' ||
            clearingAccount.accountType !== LedgerAccountType.ASSET
          ) {
            throw new ServiceUnavailableException('Activation clearing account is unavailable.');
          }
          await this.ledger.postWithinTransaction(tx, {
            idempotencyKey: `activation-payment:${request.paymentTransactionId}`,
            transactionType: 'ACTIVATION_PAYMENT',
            actorType: 'PROVIDER',
            paymentId: request.paymentTransactionId,
            reason: `Activation policy ${policy.termsVersion}`,
            lines: [
              { accountId: clearingAccount.id, debitKes: request.paymentTransaction.amountKes, creditKes: 0 },
              { accountId: creditAccount.id, debitKes: 0, creditKes: request.paymentTransaction.amountKes },
            ],
          });
          await tx.user.update({
            where: { id: request.paymentTransaction.userId },
            data: { activationStatus: 'ACTIVE' },
          });
          await tx.referral.updateMany({
            where: {
              referredUserId: request.paymentTransaction.userId,
              status: { in: ['REGISTERED', 'ACTIVATION_PENDING'] },
            },
            data: { status: 'QUALIFIED', qualifiedAt: now },
          });
        }
        await tx.authAuditLog.create({
          data: {
            actorType: 'PROVIDER',
            actorId: 'MPESA_DARAJA',
            action: 'ACTIVATION_PAYMENT_CALLBACK',
            outcome: isConfirmed ? 'CONFIRMED' : 'FAILED',
          },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const duplicateEvent = await this.prisma.paymentCallbackEvent.findFirst({
          where: { activationPaymentRequestId: request.id, payloadHash },
          select: { id: true },
        });
        if (duplicateEvent) return { ResultCode: 0, ResultDesc: 'Accepted' };
      }
      throw error;
    }
    return { ResultCode: 0, ResultDesc: 'Accepted' };
  }

  private parsePolicy(value: Prisma.JsonValue | undefined): ActivationPolicy | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const policy = value as Record<string, Prisma.JsonValue>;
    if (
      typeof policy.approved !== 'boolean' ||
      typeof policy.purpose !== 'string' ||
      !['REFUNDABLE', 'NON_REFUNDABLE', 'CONDITIONAL_REFUND'].includes(String(policy.refundability)) ||
      typeof policy.creditedToWallet !== 'boolean' ||
      typeof policy.accountingTreatment !== 'string' ||
      typeof policy.customerDisclosure !== 'string' ||
      typeof policy.termsVersion !== 'string' ||
      (policy.creditAccountCode !== null && typeof policy.creditAccountCode !== 'string')
    ) return null;
    return policy as unknown as ActivationPolicy;
  }

  private parseCallback(payload: unknown): MpesaCallback {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new BadRequestException('Invalid M-Pesa callback.');
    }
    const callback = (payload as { Body?: { stkCallback?: Record<string, unknown> } }).Body?.stkCallback;
    if (
      !callback ||
      typeof callback.CheckoutRequestID !== 'string' ||
      typeof callback.MerchantRequestID !== 'string' ||
      typeof callback.ResultCode !== 'number' ||
      !Number.isSafeInteger(callback.ResultCode) ||
      callback.ResultCode < 0 ||
      typeof callback.ResultDesc !== 'string' ||
      (callback.CallbackMetadata !== undefined &&
        (!callback.CallbackMetadata ||
          typeof callback.CallbackMetadata !== 'object' ||
          !Array.isArray((callback.CallbackMetadata as { Item?: unknown[] }).Item)))
    ) {
      throw new BadRequestException('Invalid M-Pesa callback.');
    }
    const items = (callback.CallbackMetadata as { Item?: unknown[] } | undefined)?.Item;
    if (items) {
      const names = new Set<string>();
      for (const item of items) {
        if (
          !item ||
          typeof item !== 'object' ||
          typeof (item as { Name?: unknown }).Name !== 'string' ||
          !['string', 'number'].includes(typeof (item as { Value?: unknown }).Value)
        ) {
          throw new BadRequestException('Invalid M-Pesa callback.');
        }
        const name = (item as { Name: string }).Name;
        if (names.has(name)) throw new BadRequestException('Invalid M-Pesa callback.');
        names.add(name);
      }
    }
    return callback as unknown as MpesaCallback;
  }

  private getCallbackItem(callback: MpesaCallback, name: string): string | number | null {
    return callback.CallbackMetadata?.Item?.find((item) => item.Name === name)?.Value ?? null;
  }

  private async getCreditAccount(tx: Prisma.TransactionClient, policy: ActivationPolicy, userId: string) {
    if (!policy.creditedToWallet) {
      if (!policy.creditAccountCode) throw new ServiceUnavailableException('Activation accounting policy is incomplete.');
      const account = await tx.ledgerAccount.findUnique({ where: { code: policy.creditAccountCode } });
      if (
        !account ||
        !account.isActive ||
        account.currency !== 'KES' ||
        (account.accountType !== LedgerAccountType.LIABILITY && account.accountType !== LedgerAccountType.REVENUE)
      ) {
        throw new ServiceUnavailableException('Activation accounting account is unavailable.');
      }
      return account;
    }
    const code = `WALLET_${userId}`;
    const existing = await tx.ledgerAccount.findUnique({ where: { code } });
    if (existing) {
      if (
        existing.userId !== userId ||
        existing.accountType !== LedgerAccountType.LIABILITY ||
        existing.currency !== 'KES' ||
        !existing.isActive
      ) throw new ServiceUnavailableException('Customer wallet account is unavailable.');
      return existing;
    }
    return tx.ledgerAccount.create({
      data: { code, name: 'Customer wallet', accountType: LedgerAccountType.LIABILITY, currency: 'KES', userId },
    });
  }

  private makeCallbackUrl(callbackToken: string): string {
    const configuredUrl = process.env.MPESA_CALLBACK_URL;
    if (!configuredUrl) throw new ServiceUnavailableException('M-Pesa callback URL is not configured.');
    let baseUrl: URL;
    try {
      baseUrl = new URL(configuredUrl);
    } catch {
      throw new ServiceUnavailableException('M-Pesa callback URL is not configured.');
    }
    if (process.env.NODE_ENV === 'production') {
      if (
        baseUrl.protocol !== 'https:' ||
        baseUrl.username ||
        baseUrl.password ||
        baseUrl.search ||
        baseUrl.hash ||
        !/(?:^|\/)api\/v1\/payments\/mpesa\/callback\/?$/.test(baseUrl.pathname)
      ) {
        throw new ServiceUnavailableException('M-Pesa callback URL must be the public HTTPS payment callback route.');
      }
    }
    baseUrl.pathname = `${baseUrl.pathname.replace(/\/$/, '')}/${callbackToken}`;
    return baseUrl.toString();
  }
}