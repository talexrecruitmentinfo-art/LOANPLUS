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
    if (!termsApproved) {
      return {
        available: false,
        availabilityReason: 'Approved KES 50 activation policy is not configured.',
        amountKes: ACTIVATION_AMOUNT_KES,
        currency: 'KES',
        terms: null,
      };
    }

    let destination: ReturnType<MpesaService['getCustomerPaymentDestination']> | null = null;
    let availabilityReason: string | null = null;
    try {
      destination = this.mpesa.getCustomerPaymentDestination();
    } catch (error) {
      if (error instanceof InternalServerErrorException || error instanceof ServiceUnavailableException) {
        availabilityReason = error.message;
      } else {
        throw error;
      }
    }
    if (destination) {
      try {
        buildMpesaCallbackUrl('configuration-check');
      } catch (error) {
        if (error instanceof InternalServerErrorException) availabilityReason = error.message;
        else throw error;
      }
    }
    return {
      available: destination !== null && availabilityReason === null,
      availabilityReason,
      amountKes: ACTIVATION_AMOUNT_KES,
      currency: 'KES',
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
        where: {
          userId,
          type: PaymentType.ACTIVATION,
          OR: [
            { status: PaymentStatus.PENDING },
            { status: PaymentStatus.FAILED, failureCode: 'MPESA_RESULT_4999' },
          ],
        },
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
    const payments = await this.prisma.paymentTransaction.findMany({
      where: { userId },
      select: {
        internalReference: true,
        type: true,
        amountKes: true,
        currency: true,
        status: true,
        failureCode: true,
        providerReference: true,
        receiptReference: true,
        confirmedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return payments.map((payment) => {
      const { failureCode, ...customerPayment } = payment;
      const unresolvedLegacyProcessing =
        payment.status === PaymentStatus.FAILED &&
        failureCode === 'MPESA_RESULT_4999' &&
        payment.receiptReference === null;
      const status = unresolvedLegacyProcessing ? PaymentStatus.PENDING : payment.status;
      const resultCode = payment.receiptReference ? 0 : this.getPersistedProviderResultCode(failureCode);
      return {
        ...customerPayment,
        status,
        providerResult: {
          code: resultCode,
          message: this.getCustomerPaymentMessage(status, resultCode),
        },
      };
    });
  }

  async listReconciliationQueue(cursor?: string, requestedLimit = 50) {
    const limit = Math.min(Math.max(Math.floor(requestedLimit || 50), 1), 100);
    const setting = await this.prisma.systemSetting.findUnique({
      where: { key: 'payments.reconciliation.pending_minutes' },
      select: { value: true },
    });
    const configuredMinutes = typeof setting?.value === 'number' ? setting.value : 5;
    const thresholdMinutes = Number.isInteger(configuredMinutes) && configuredMinutes >= 1 && configuredMinutes <= 1440
      ? configuredMinutes
      : 5;
    const cutoff = new Date(Date.now() - thresholdMinutes * 60_000);
    const rows = await this.prisma.paymentTransaction.findMany({
      where: {
        type: PaymentType.ACTIVATION,
        OR: [
          { status: PaymentStatus.PENDING, createdAt: { lte: cutoff } },
          { status: PaymentStatus.FAILED, failureCode: 'MPESA_RESULT_4999' },
        ],
      },
      select: {
        id: true,
        internalReference: true,
        amountKes: true,
        currency: true,
        status: true,
        failureCode: true,
        providerReference: true,
        receiptReference: true,
        createdAt: true,
        updatedAt: true,
        user: { select: { fullName: true, email: true } },
        activationRequest: {
          select: {
            checkoutRequestId: true,
            merchantRequestId: true,
            callbackEvents: {
              select: { providerResultCode: true, providerReceiptReference: true, receivedAt: true },
              orderBy: { receivedAt: 'desc' },
              take: 5,
            },
          },
        },
        reconciliationAttempts: {
          select: {
            id: true,
            outcome: true,
            providerResultCode: true,
            reasonCode: true,
                operatorNote: true,
            requestedAt: true,
            completedAt: true,
            superadmin: { select: { email: true } },
          },
          orderBy: { requestedAt: 'desc' },
          take: 5,
        },
        _count: { select: { reconciliationAttempts: true } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: items.map((payment) => {
        const { failureCode, ...queuePayment } = payment;
        return {
          ...queuePayment,
          recordedStatus: payment.status,
          status: payment.status === PaymentStatus.FAILED && failureCode === 'MPESA_RESULT_4999'
            ? PaymentStatus.PENDING
            : payment.status,
          reconciliationStatus: failureCode === 'MPESA_RESULT_4999' ? 'LEGACY_UNRESOLVED_4999' : 'PENDING',
        };
      }),
      nextCursor: hasMore ? items.at(-1)?.id ?? null : null,
      pendingThresholdMinutes: thresholdMinutes,
    };
  }

  async reconcileActivationPayment(
    paymentId: string,
    idempotencyKey: string | undefined,
    superadminId: string,
    operatorNote: string,
    ipAddress?: string,
  ) {
    if (!idempotencyKey || !/^[a-zA-Z0-9._:-]{16,128}$/.test(idempotencyKey)) {
      throw new BadRequestException('A valid Idempotency-Key header is required.');
    }
    const sanitizedNote = operatorNote.trim();
    if (sanitizedNote.length < 10 || sanitizedNote.length > 500) {
      throw new BadRequestException('An investigation note between 10 and 500 characters is required.');
    }

    const now = new Date();
    let attempt: { id: string; outcome: string; providerResultCode: string | null; reasonCode: string | null };
    let payment: Prisma.PaymentTransactionGetPayload<{ include: { activationRequest: true } }> | null;
    try {
      const started = await this.prisma.$transaction(async (tx) => {
        const existing = await tx.paymentReconciliationAttempt.findUnique({
          where: { paymentTransactionId_idempotencyKey: { paymentTransactionId: paymentId, idempotencyKey } },
          select: { id: true, outcome: true, providerResultCode: true, reasonCode: true, superadminId: true },
        });
        if (existing) {
          if (existing.superadminId !== superadminId) {
            throw new ConflictException('This idempotency key belongs to another administrator.');
          }
          return { attempt: existing, payment: null, duplicate: true };
        }

        const currentPayment = await tx.paymentTransaction.findUnique({
          where: { id: paymentId },
          include: { activationRequest: true },
        });
        if (!currentPayment) throw new NotFoundException('Payment was not found.');
        this.assertActivationPaymentAssociation(currentPayment, {
          paymentTransactionId: currentPayment.id,
          userId: currentPayment.activationRequest?.userId ?? '',
        });
        const isLegacyUnresolved =
          currentPayment.status === PaymentStatus.FAILED &&
          currentPayment.failureCode === 'MPESA_RESULT_4999' &&
          currentPayment.receiptReference === null;
        if (currentPayment.status !== PaymentStatus.PENDING && !isLegacyUnresolved) {
          throw new ConflictException('Only unresolved activation payments can be reconciled.');
        }
        const recentAttempt = await tx.paymentReconciliationAttempt.findFirst({
          where: {
            paymentTransactionId: paymentId,
            outcome: 'STARTED',
            requestedAt: { gt: new Date(now.getTime() - 60_000) },
          },
          select: { id: true },
        });
        if (recentAttempt) throw new ConflictException('A status refresh is already in progress for this payment.');

        const createdAttempt = await tx.paymentReconciliationAttempt.create({
          data: { paymentTransactionId: paymentId, superadminId, idempotencyKey, operatorNote: sanitizedNote },
          select: { id: true, outcome: true, providerResultCode: true, reasonCode: true, operatorNote: true },
        });
        await tx.adminAuditLog.create({
          data: {
            superadminId,
            action: 'PAYMENT_RECONCILIATION_STARTED',
            subjectType: 'PAYMENT_TRANSACTION',
            subjectId: paymentId,
            outcome: 'STARTED',
            reason: sanitizedNote,
            ipAddress: ipAddress?.slice(0, 64),
          },
        });
        return { attempt: createdAttempt, payment: currentPayment, duplicate: false };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      attempt = started.attempt;
      payment = started.payment;
      if (started.duplicate || !payment) return attempt;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const duplicate = await this.prisma.paymentReconciliationAttempt.findUnique({
          where: { paymentTransactionId_idempotencyKey: { paymentTransactionId: paymentId, idempotencyKey } },
          select: { id: true, outcome: true, providerResultCode: true, reasonCode: true, operatorNote: true, superadminId: true },
        });
        if (duplicate) {
          if (duplicate.superadminId !== superadminId) {
            throw new ConflictException('This idempotency key belongs to another administrator.');
          }
          return duplicate;
        }
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
        throw new ConflictException('Another reconciliation request is being processed. Try again shortly.');
      }
      throw error;
    }

    const activationRequest = payment.activationRequest;
    if (!activationRequest?.checkoutRequestId || !activationRequest.merchantRequestId) {
      return this.completeReconciliationAttempt(attempt.id, paymentId, superadminId, ipAddress, {
        outcome: 'UNRESOLVED_MISSING_IDENTIFIERS',
        reasonCode: 'PROVIDER_IDENTIFIERS_MISSING',
      });
    }

    let providerStatus: Awaited<ReturnType<MpesaService['queryStkStatus']>>;
    try {
      providerStatus = await this.mpesa.queryStkStatus(activationRequest.checkoutRequestId);
    } catch (error) {
      if (!(error instanceof ServiceUnavailableException) && !(error instanceof InternalServerErrorException)) {
        await this.completeReconciliationAttempt(attempt.id, paymentId, superadminId, ipAddress, {
          outcome: 'QUERY_ERROR',
          reasonCode: 'INTERNAL_QUERY_ERROR',
        });
        throw error;
      }
      return this.completeReconciliationAttempt(attempt.id, paymentId, superadminId, ipAddress, {
        outcome: 'UNRESOLVED_PROVIDER_UNAVAILABLE',
        reasonCode: 'PROVIDER_UNAVAILABLE',
      });
    }

    if (
      providerStatus.checkoutRequestId !== activationRequest.checkoutRequestId ||
      providerStatus.merchantRequestId !== activationRequest.merchantRequestId
    ) {
      return this.completeReconciliationAttempt(attempt.id, paymentId, superadminId, ipAddress, {
        outcome: 'UNRESOLVED_IDENTIFIER_MISMATCH',
        providerResultCode: String(providerStatus.resultCode),
        reasonCode: 'PROVIDER_IDENTIFIERS_MISMATCH',
      });
    }

    if (providerStatus.resultCode === 4999) {
      return this.completeReconciliationAttempt(attempt.id, paymentId, superadminId, ipAddress, {
        outcome: 'UNRESOLVED_PROCESSING',
        providerResultCode: '4999',
        reasonCode: 'PROVIDER_STILL_PROCESSING',
      });
    }
    if (providerStatus.resultCode === 0) {
      return this.completeReconciliationAttempt(attempt.id, paymentId, superadminId, ipAddress, {
        outcome: 'SUCCESS_AWAITING_VERIFIED_CALLBACK',
        providerResultCode: '0',
        reasonCode: 'QUERY_SUCCESS_CALLBACK_METADATA_REQUIRED',
      });
    }
    const terminalStatus = this.getTerminalProviderStatus(providerStatus.resultCode);
    if (!terminalStatus) {
      return this.completeReconciliationAttempt(attempt.id, paymentId, superadminId, ipAddress, {
        outcome: 'UNRESOLVED_UNKNOWN_RESULT',
        providerResultCode: String(providerStatus.resultCode),
        reasonCode: 'UNRECOGNIZED_PROVIDER_RESULT',
      });
    }

    let outcome: string;
    let reasonCode: string;
    try {
      await this.settleActivationPayment(payment, activationRequest, providerStatus);
      outcome = `RESOLVED_${terminalStatus}`;
      reasonCode = 'AUTHORITATIVE_TERMINAL_QUERY';
    } catch (error) {
      const current = await this.prisma.paymentTransaction.findUnique({ where: { id: paymentId }, select: { status: true } });
      if (current && current.status !== PaymentStatus.PENDING) {
        outcome = `ALREADY_RESOLVED_${current.status}`;
        reasonCode = 'PAYMENT_RESOLVED_CONCURRENTLY';
      } else {
        await this.completeReconciliationAttempt(attempt.id, paymentId, superadminId, ipAddress, {
          outcome: 'QUERY_ERROR',
          providerResultCode: String(providerStatus.resultCode),
          reasonCode: 'SETTLEMENT_CONFLICT',
        });
        throw error;
      }
    }
    return this.completeReconciliationAttempt(attempt.id, paymentId, superadminId, ipAddress, {
      outcome,
      providerResultCode: String(providerStatus.resultCode),
      reasonCode,
    });
  }

  private async completeReconciliationAttempt(
    attemptId: string,
    paymentId: string,
    superadminId: string,
    ipAddress: string | undefined,
    result: { outcome: string; providerResultCode?: string; reasonCode: string },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const attempt = await tx.paymentReconciliationAttempt.update({
        where: { id: attemptId },
        data: {
          outcome: result.outcome,
          providerResultCode: result.providerResultCode ?? null,
          reasonCode: result.reasonCode,
          completedAt: new Date(),
        },
        select: { id: true, outcome: true, providerResultCode: true, reasonCode: true, operatorNote: true, requestedAt: true, completedAt: true },
      });
      await tx.adminAuditLog.create({
        data: {
          superadminId,
          action: 'PAYMENT_RECONCILIATION_COMPLETED',
          subjectType: 'PAYMENT_TRANSACTION',
          subjectId: paymentId,
          outcome: result.outcome,
          reason: result.reasonCode,
          ipAddress: ipAddress?.slice(0, 64),
        },
      });
      return attempt;
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

    let statusCheckMessage: string | null = null;
    const previouslyMisclassifiedAsFailed =
      transaction.status === PaymentStatus.FAILED &&
      transaction.failureCode === 'MPESA_RESULT_4999' &&
      transaction.receiptReference === null;
    if (
      (transaction.status === PaymentStatus.PENDING || previouslyMisclassifiedAsFailed) &&
      transaction.type === PaymentType.ACTIVATION &&
      transaction.amountKes === ACTIVATION_AMOUNT_KES &&
      transaction.currency === 'KES' &&
      transaction.activationRequest?.userId === userId
    ) {
      const request = transaction.activationRequest;
      const checkoutRequestId = request.checkoutRequestId;
      const merchantRequestId = request.merchantRequestId;
      if (!checkoutRequestId || !merchantRequestId) {
        statusCheckMessage = 'Payment remains pending because provider identifiers are not available for a status check.';
      } else {
        let providerStatus: Awaited<ReturnType<MpesaService['queryStkStatus']>> | null = null;
        try {
          providerStatus = await this.mpesa.queryStkStatus(checkoutRequestId);
        } catch (error) {
          if (error instanceof ServiceUnavailableException || error instanceof InternalServerErrorException) {
            statusCheckMessage = 'Payment remains pending. Provider status could not be refreshed; try refreshing again.';
          } else {
            throw error;
          }
        }
        if (providerStatus) {
          if (
            providerStatus.checkoutRequestId !== checkoutRequestId ||
            providerStatus.merchantRequestId !== merchantRequestId
          ) {
            statusCheckMessage = 'Payment is still pending because its provider status could not be verified.';
          } else if (providerStatus.resultCode === 4999) {
            statusCheckMessage = 'Safaricom reports that the payment request is still processing. Do not submit another payment.';
          } else if (providerStatus.resultCode === 0) {
            statusCheckMessage = 'Safaricom has not yet sent the payment confirmation. The payment remains pending.';
          } else if (this.getTerminalProviderStatus(providerStatus.resultCode) === null) {
            statusCheckMessage = 'Safaricom returned a result that does not conclusively resolve this payment. It remains pending; do not submit another payment.';
          } else {
            await this.settleActivationPayment(transaction, request, providerStatus);
          }
        }
      }
    }
    const [refreshedUser, latestTransaction] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { activationStatus: true } }),
      this.prisma.paymentTransaction.findFirst({
        where: { userId, type: PaymentType.ACTIVATION },
        include: { activationRequest: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    if (!refreshedUser) throw new NotFoundException('Customer account was not found.');
    if (!latestTransaction) return { activationStatus: refreshedUser.activationStatus, payment: null };
    const providerResultCode = latestTransaction.receiptReference
      ? 0
      : this.getPersistedProviderResultCode(latestTransaction.failureCode);
    const effectiveStatus =
      latestTransaction.status === PaymentStatus.FAILED &&
      latestTransaction.failureCode === 'MPESA_RESULT_4999' &&
      latestTransaction.receiptReference === null
        ? PaymentStatus.PENDING
        : latestTransaction.status;
    return {
      activationStatus: refreshedUser.activationStatus,
      payment: {
        paymentId: latestTransaction.id,
        type: latestTransaction.type,
        purpose: 'Account activation',
        reference: latestTransaction.internalReference,
        status: effectiveStatus,
        amountKes: latestTransaction.amountKes,
        currency: latestTransaction.currency,
        createdAt: latestTransaction.createdAt,
        updatedAt: latestTransaction.updatedAt,
        providerResult: {
          code: providerResultCode,
          receiptReference: latestTransaction.receiptReference,
          message: this.getCustomerPaymentMessage(effectiveStatus, providerResultCode),
        },
        accountActivated:
          effectiveStatus === PaymentStatus.CONFIRMED &&
          refreshedUser.activationStatus === 'ACTIVE',
        statusCheckMessage,
      },
    };
  }

  private getPersistedProviderResultCode(failureCode: string | null): number | null {
    const match = /^MPESA_RESULT_(\d+)$/.exec(failureCode ?? '');
    return match ? Number(match[1]) : null;
  }

  private getCustomerPaymentMessage(status: PaymentStatus, resultCode: number | null): string {
    if (status === PaymentStatus.CONFIRMED) return 'Safaricom confirmed this payment.';
    if (status === PaymentStatus.PENDING && resultCode === 4999) {
      return 'Safaricom reports that the payment request is still processing. Do not submit another payment.';
    }
    if (status === PaymentStatus.CANCELLED) return 'The M-Pesa payment was cancelled.';
    if (status === PaymentStatus.EXPIRED) return 'The M-Pesa payment expired without confirmation.';
    if (status === PaymentStatus.REVERSED) return 'This payment was reversed.';
    if (status === PaymentStatus.FAILED) {
      return resultCode === null
        ? 'Safaricom reported that this payment failed.'
        : `Safaricom reported that this payment failed (result ${resultCode}).`;
    }
    return 'Payment confirmation has not been conclusively received. Do not submit another payment while this one is pending.';
  }

  async handleMpesaCallback(callbackToken: string, payload: unknown): Promise<{ ResultCode: number; ResultDesc: string }> {
    const callback = this.parseCallback(payload);
    const callbackTokenHash = hashToken(callbackToken);
    const request = await this.prisma.activationPaymentRequest.findUnique({
      where: { callbackTokenHash },
      include: { paymentTransaction: true },
    });
    if (!request) {
      throw new NotFoundException('Payment callback is invalid.');
    }
    if (
      (request.checkoutRequestId !== null && callback.CheckoutRequestID !== request.checkoutRequestId) ||
      (request.merchantRequestId !== null && callback.MerchantRequestID !== request.merchantRequestId) ||
      (request.checkoutRequestId === null) !== (request.merchantRequestId === null)
    ) {
      throw new ForbiddenException('Payment callback did not match the requested transaction.');
    }
    this.assertActivationPaymentAssociation(request.paymentTransaction, request);

    const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const priorEvent = await this.prisma.paymentCallbackEvent.findFirst({
      where: { activationPaymentRequestId: request.id, payloadHash },
      select: { id: true },
    });
    if (priorEvent) return { ResultCode: 0, ResultDesc: 'Accepted' };

    const providerStatus = await this.mpesa.queryStkStatus(
      request.checkoutRequestId ?? callback.CheckoutRequestID,
    );
    if (
      providerStatus.checkoutRequestId !== callback.CheckoutRequestID ||
      providerStatus.merchantRequestId !== callback.MerchantRequestID ||
      providerStatus.resultCode !== callback.ResultCode
    ) {
      throw new ServiceUnavailableException('M-Pesa callback could not be reconciled with provider status.');
    }
    await this.settleActivationPayment(
      request.paymentTransaction,
      {
        ...request,
        checkoutRequestId: providerStatus.checkoutRequestId,
        merchantRequestId: providerStatus.merchantRequestId,
      },
      providerStatus,
      callback,
      payloadHash,
    );
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

  private getTerminalProviderStatus(_resultCode: number): PaymentStatus | null {
    // No source-verified nonzero Daraja result-code mapping is configured yet.
    return null;
  }

  /**
  * Request acceptance, result 4999, unknown provider results, and temporary query errors remain unresolved.
   * Query-only success remains pending until a token-bound callback supplies verifiable success metadata.
   * Only PENDING and legacy FAILED/MPESA_RESULT_4999 records may transition; other verified terminal outcomes stay immutable.
   * Provider outcome, receipt, balanced ledger posting, and activation commit together in one serializable transaction.
   */
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
    const targetStatus = isConfirmed
      ? PaymentStatus.CONFIRMED
      : this.getTerminalProviderStatus(providerStatus.resultCode);
    if (targetStatus === null) {
      if (payloadHash) await this.recordUnresolvedCallback(request, providerStatus.resultCode, payloadHash);
      return;
    }
    let policy: ActivationPolicy | null = null;
    if (isConfirmed) {
      policy = this.parsePolicy(request.policySnapshot ?? undefined);
      if (!policy?.approved || /^draft(?:[-_. ]|$)/i.test(policy.termsVersion.trim())) {
        throw new ServiceUnavailableException('Activation accounting policy is unavailable.');
      }
    }
    if (isConfirmed && !callback) {
      throw new ForbiddenException('A verified M-Pesa callback is required to confirm this payment.');
    }
    const receiptReference = callback && isConfirmed
      ? this.validateSuccessfulCallback(callback, payment, request.phoneNumberCiphertext)
      : null;

    const now = new Date();
    try {
      await this.prisma.$transaction(async (tx) => {
        const boundRequest = await tx.activationPaymentRequest.updateMany({
          where: {
            id: request.id,
            paymentTransactionId: request.paymentTransactionId,
            userId: request.userId,
            OR: [
              { checkoutRequestId: null, merchantRequestId: null },
              {
                checkoutRequestId: request.checkoutRequestId,
                merchantRequestId: request.merchantRequestId,
              },
            ],
          },
          data: {
            checkoutRequestId: request.checkoutRequestId,
            merchantRequestId: request.merchantRequestId,
          },
        });
        if (boundRequest.count !== 1) {
          throw new ConflictException('Payment provider identifiers could not be safely associated.');
        }
        if (payloadHash) {
          await tx.paymentCallbackEvent.create({
            data: {
              activationPaymentRequestId: request.id,
              paymentTransactionId: request.paymentTransactionId,
              payloadHash,
              providerResultCode: String(providerStatus.resultCode),
              providerReceiptReference: receiptReference,
            },
          });
        }
        const changed = await tx.paymentTransaction.updateMany({
          where: {
            id: request.paymentTransactionId,
            OR: [
              { status: PaymentStatus.PENDING },
              { status: PaymentStatus.FAILED, failureCode: 'MPESA_RESULT_4999' },
            ],
          },
          data: {
            status: targetStatus,
            providerReference: request.checkoutRequestId,
            receiptReference,
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

  private async recordUnresolvedCallback(
    request: {
      id: string;
      paymentTransactionId: string;
      userId: string;
      checkoutRequestId: string | null;
      merchantRequestId: string | null;
    },
    resultCode: number,
    payloadHash: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const boundRequest = await tx.activationPaymentRequest.updateMany({
        where: {
          id: request.id,
          paymentTransactionId: request.paymentTransactionId,
          userId: request.userId,
          OR: [
            { checkoutRequestId: null, merchantRequestId: null },
            {
              checkoutRequestId: request.checkoutRequestId,
              merchantRequestId: request.merchantRequestId,
            },
          ],
        },
        data: {
          checkoutRequestId: request.checkoutRequestId,
          merchantRequestId: request.merchantRequestId,
        },
      });
      if (boundRequest.count !== 1) {
        throw new ConflictException('Payment provider identifiers could not be safely associated.');
      }
      await tx.paymentCallbackEvent.create({
        data: {
          activationPaymentRequestId: request.id,
          paymentTransactionId: request.paymentTransactionId,
          payloadHash,
          providerResultCode: String(resultCode),
          providerReceiptReference: null,
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private validateSuccessfulCallback(
    callback: MpesaCallback,
    payment: { amountKes: number; currency: string },
    phoneNumberCiphertext: string | null,
  ): string {
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
      return receipt;
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