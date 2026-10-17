import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
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
import { buildMpesaCallbackUrl } from './mpesa-callback-url';

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

const ACTIVATION_AMOUNT_KES = 50;

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
    const termsApproved = policy?.approved === true &&
      policy.termsVersion.trim().length > 0 &&
      !/^draft(?:[-_. ]|$)/i.test(policy.termsVersion.trim()) &&
      amount?.value === ACTIVATION_AMOUNT_KES;
    const destination = termsApproved ? this.mpesa.getCustomerPaymentDestination() : null;
    let callbackConfigured = false;
    if (destination) {
      try {
        buildMpesaCallbackUrl('configuration-check');
        callbackConfigured = true;
      } catch (error) {
        if (!(error instanceof ServiceUnavailableException) && !(error instanceof InternalServerErrorException)) throw error;
      }
    }
    if (!termsApproved) {
      return { available: false, amountKes: ACTIVATION_AMOUNT_KES, currency: 'KES', destination: null, terms: null };
    }
    return {
      available: destination !== null && callbackConfigured,
      amountKes: ACTIVATION_AMOUNT_KES,
      currency: 'KES',
      destination,
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
      .update(JSON.stringify({ userId, phoneNumber, termsVersion: dto.termsVersion.trim() }))
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
    const amountKes = amountSetting?.value;
    const policy = this.parsePolicy(policySetting?.value);
    if (
      amountKes !== ACTIVATION_AMOUNT_KES ||
      !policy?.approved ||
      !policy.termsVersion.trim() ||
      /^draft(?:[-_. ]|$)/i.test(policy.termsVersion.trim())
    ) {
      throw new ServiceUnavailableException('Activation payment terms are not configured.');
    }
    if (dto.termsVersion.trim() !== policy.termsVersion.trim()) {
      throw new ConflictException('Activation terms have changed. Review the current terms and try again.');
    }

    const callbackToken = randomBytes(32).toString('base64url');
    const callbackUrl = buildMpesaCallbackUrl(callbackToken);
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
              termsAcceptedVersion: policy.termsVersion.trim(),
              termsAcceptedAt: new Date(),
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

    let providerRequest: { checkoutRequestId: string; merchantRequestId: string };
    try {
      providerRequest = await this.mpesa.initiateStkPush({
        amountKes,
        phoneNumber: phoneNumber.slice(1),
        accountReference: payment.internalReference.slice(-12),
        description: 'Activation',
        callbackUrl,
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
    await this.prisma.activationPaymentRequest.update({
      where: { paymentTransactionId: payment.id },
      data: {
        checkoutRequestId: providerRequest.checkoutRequestId,
        merchantRequestId: providerRequest.merchantRequestId,
      },
    });

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

  async getCustomerActivationStatus(userId: string) {
    const [user, transaction] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { activationStatus: true } }),
      this.prisma.paymentTransaction.findFirst({
        where: { userId, type: PaymentType.ACTIVATION },
        include: { activationRequest: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    if (!user) throw new NotFoundException('Customer account was not found.');
    if (!transaction) return { activationStatus: user.activationStatus, payment: null };

    let status = transaction.status;
    if (
      status === PaymentStatus.PENDING &&
      transaction.type === PaymentType.ACTIVATION &&
      transaction.amountKes === ACTIVATION_AMOUNT_KES &&
      transaction.currency === 'KES' &&
      transaction.activationRequest?.userId === userId &&
      transaction.activationRequest.checkoutRequestId &&
      transaction.activationRequest.merchantRequestId
    ) {
      const request = transaction.activationRequest;
      const checkoutRequestId = request.checkoutRequestId;
      const merchantRequestId = request.merchantRequestId;
      if (!checkoutRequestId || !merchantRequestId) {
        throw new ServiceUnavailableException('M-Pesa payment status is not available yet.');
      }
      const providerStatus = await this.mpesa.queryStkStatus(checkoutRequestId);
      if (
        providerStatus.checkoutRequestId !== checkoutRequestId ||
        providerStatus.merchantRequestId !== merchantRequestId
      ) {
        throw new ServiceUnavailableException('M-Pesa payment status did not match the stored request.');
      }
      await this.settleActivationPayment(transaction, request, providerStatus);
      status = providerStatus.resultCode === 0
        ? PaymentStatus.CONFIRMED
        : this.getTerminalProviderStatus(providerStatus.resultCode);
    }
    const refreshedUser = status === PaymentStatus.CONFIRMED
      ? await this.prisma.user.findUnique({ where: { id: userId }, select: { activationStatus: true } })
      : user;
    return {
      activationStatus: refreshedUser?.activationStatus ?? user.activationStatus,
      payment: {
        reference: transaction.internalReference,
        status,
        amountKes: transaction.amountKes,
        currency: transaction.currency,
        createdAt: transaction.createdAt,
      },
    };
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
    this.assertActivationPaymentAssociation(request.paymentTransaction, request);

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
    await this.settleActivationPayment(request.paymentTransaction, request, providerStatus, callback, payloadHash);
    return { ResultCode: 0, ResultDesc: 'Accepted' };
  }

  private assertActivationPaymentAssociation(
    payment: { id: string; userId: string; type: PaymentType; amountKes: number; currency: string },
    request: { paymentTransactionId: string; userId: string },
  ): void {
    if (
      payment.id !== request.paymentTransactionId ||
      payment.userId !== request.userId ||
      payment.type !== PaymentType.ACTIVATION ||
      payment.amountKes !== ACTIVATION_AMOUNT_KES ||
      payment.currency !== 'KES'
    ) {
      throw new ForbiddenException('Payment callback did not match an activation payment.');
    }
  }

  private getTerminalProviderStatus(resultCode: number): PaymentStatus {
    if (resultCode === 1032) return PaymentStatus.CANCELLED;
    if (resultCode === 1037) return PaymentStatus.EXPIRED;
    return PaymentStatus.FAILED;
  }

  private async settleActivationPayment(
    payment: {
      id: string;
      userId: string;
      type: PaymentType;
      amountKes: number;
      currency: string;
      status: PaymentStatus;
    },
    request: {
      id: string;
      paymentTransactionId: string;
      userId: string;
      checkoutRequestId: string | null;
      merchantRequestId: string | null;
      phoneNumberCiphertext: string | null;
      policySnapshot: Prisma.JsonValue | null;
    },
    providerStatus: { checkoutRequestId: string; merchantRequestId: string; resultCode: number },
    callback?: MpesaCallback,
    payloadHash?: string,
  ): Promise<void> {
    this.assertActivationPaymentAssociation(payment, request);
    if (
      !request.checkoutRequestId ||
      !request.merchantRequestId ||
      providerStatus.checkoutRequestId !== request.checkoutRequestId ||
      providerStatus.merchantRequestId !== request.merchantRequestId
    ) {
      throw new ServiceUnavailableException('M-Pesa payment status did not match the stored request.');
    }
    const isConfirmed = providerStatus.resultCode === 0;
    const targetStatus = isConfirmed ? PaymentStatus.CONFIRMED : this.getTerminalProviderStatus(providerStatus.resultCode);
    let policy: ActivationPolicy | null = null;
    if (isConfirmed) {
      policy = this.parsePolicy(request.policySnapshot ?? undefined);
      if (!policy?.approved || /^draft(?:[-_. ]|$)/i.test(policy.termsVersion.trim())) {
        throw new ServiceUnavailableException('Activation accounting policy is unavailable.');
      }
    }
    if (callback && isConfirmed) this.validateSuccessfulCallback(callback, payment, request.phoneNumberCiphertext);

    const now = new Date();
    try {
      await this.prisma.$transaction(async (tx) => {
        if (payloadHash) {
          await tx.paymentCallbackEvent.create({
            data: {
              activationPaymentRequestId: request.id,
              paymentTransactionId: request.paymentTransactionId,
              payloadHash,
              providerResultCode: String(providerStatus.resultCode),
              providerReceiptReference: null,
            },
          });
        }
        const changed = await tx.paymentTransaction.updateMany({
          where: { id: request.paymentTransactionId, status: PaymentStatus.PENDING },
          data: {
            status: targetStatus,
            providerReference: request.checkoutRequestId,
            receiptReference: null,
            confirmedAt: isConfirmed ? now : null,
            failureCode: isConfirmed ? null : `MPESA_RESULT_${providerStatus.resultCode}`,
          },
        });
        if (changed.count === 0) {
          const current = await tx.paymentTransaction.findUniqueOrThrow({ where: { id: request.paymentTransactionId } });
          if (current.status === targetStatus) return;
          throw new ConflictException('Payment has already been reconciled.');
        }

        if (isConfirmed && policy) {
          const creditAccount = await this.getCreditAccount(tx, policy, payment.userId);
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
            idempotencyKey: `activation-payment:${payment.id}`,
            transactionType: 'ACTIVATION_PAYMENT',
            actorType: 'PROVIDER',
            paymentId: payment.id,
            reason: `Activation policy ${policy.termsVersion}`,
            lines: [
              { accountId: clearingAccount.id, debitKes: ACTIVATION_AMOUNT_KES, creditKes: 0 },
              { accountId: creditAccount.id, debitKes: 0, creditKes: ACTIVATION_AMOUNT_KES },
            ],
          });
          await tx.user.update({
            where: { id: payment.userId },
            data: { activationStatus: 'ACTIVE' },
          });
          await tx.referral.updateMany({
            where: {
              referredUserId: payment.userId,
              status: { in: ['REGISTERED', 'ACTIVATION_PENDING'] },
            },
            data: { status: 'QUALIFIED', qualifiedAt: now },
          });
        }
        await tx.authAuditLog.create({
          data: {
            actorType: 'PROVIDER',
            actorId: 'MPESA_DARAJA',
            action: 'ACTIVATION_PAYMENT_RECONCILIATION',
            outcome: targetStatus,
          },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' && payloadHash) {
        const duplicateEvent = await this.prisma.paymentCallbackEvent.findFirst({
          where: { activationPaymentRequestId: request.id, payloadHash },
          select: { id: true },
        });
        if (duplicateEvent) return;
      }
      throw error;
    }
  }

  private validateSuccessfulCallback(
    callback: MpesaCallback,
    payment: { amountKes: number; currency: string },
    phoneNumberCiphertext: string | null,
  ): void {
    const receipt = this.getCallbackItem(callback, 'MpesaReceiptNumber');
    const amount = this.getCallbackItem(callback, 'Amount');
    const phoneNumber = this.getCallbackItem(callback, 'PhoneNumber');
    if (
      payment.currency !== 'KES' ||
      payment.amountKes !== ACTIVATION_AMOUNT_KES ||
      typeof amount !== 'number' ||
      !Number.isSafeInteger(amount) ||
      amount !== ACTIVATION_AMOUNT_KES ||
      typeof receipt !== 'string' ||
      !/^[A-Za-z0-9]{6,32}$/.test(receipt) ||
      (typeof phoneNumber !== 'number' && typeof phoneNumber !== 'string')
    ) {
      throw new ServiceUnavailableException('M-Pesa confirmation did not match the requested payment.');
    }
    try {
      if (!phoneNumberCiphertext) throw new Error('Payment phone number is unavailable.');
      const expectedPhone = normalizeKenyaPhone(decryptSensitiveValue(phoneNumberCiphertext));
      const confirmedPhone = normalizeKenyaPhone(String(phoneNumber));
      if (expectedPhone !== confirmedPhone) {
        throw new ServiceUnavailableException('M-Pesa confirmation did not match the requested payment.');
      }
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException('M-Pesa confirmation did not match the requested payment.');
    }
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

}