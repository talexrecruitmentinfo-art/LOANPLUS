import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  Injectable,
  Logger,
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
import { MpesaService, StkPushInitiationError, StkPushPreflightError } from './mpesa.service';
import { InitiateLoanProcessingFeeDto, WalletDepositDto } from './payment.dto';
import { buildMpesaCallbackUrl } from './mpesa-callback-url';
import { getLoanProcessingFeePolicy, LOAN_PROCESSING_FEE_KES } from './processing-fee.constants';
import { OUTSTANDING_LOAN_STATUSES } from '../loans/loan-eligibility.constants';
import {
  CUSTOMER_WALLET_LIABILITY_ACCOUNT_CODE,
  MAX_WALLET_DEPOSIT_AMOUNT_KES,
  MPESA_CLEARING_ACCOUNT_CODE,
  WALLET_DEPOSIT_SETTING_KEY,
} from './wallet-deposit.config';

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

export type ReconciliationQueueCategory = 'ALL' | 'AGED_PENDING' | 'LEGACY_4999' | 'PROVIDER_REVIEW';

const PROVIDER_REVIEW_OUTCOMES = new Set([
  'STARTED',
  'ESCALATED',
  'UNRESOLVED_MISSING_IDENTIFIERS',
  'UNRESOLVED_PROVIDER_UNAVAILABLE',
  'UNRESOLVED_IDENTIFIER_MISMATCH',
  'UNRESOLVED_4999',
  'UNRESOLVED_PROCESSING',
  'UNRESOLVED_UNKNOWN_RESULT',
  'SUCCESS_AWAITING_VERIFIED_CALLBACK',
  'EVIDENCE_SUBMITTED_AWAITING_REVIEW',
  'QUERY_ERROR',
]);

const ACTIVATION_AMOUNT_KES = 50;
const logger = new Logger('PaymentService');
interface MpesaCallback {
  CheckoutRequestID: string;
  MerchantRequestID: string;
  ResultCode: number;
  ResultDesc: string;
  CallbackMetadata?: { Item?: Array<{ Name: string; Value?: string | number }> };
}

function hasAcceptedProductTerms(applicationData: Prisma.JsonValue, productId: string, requestedPrincipalKes: number): boolean {
  if (!applicationData || typeof applicationData !== 'object' || Array.isArray(applicationData)) return false;
  const snapshot = applicationData.productTermsSnapshot;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
  return applicationData.termsAccepted === true &&
    typeof applicationData.termsAcceptedAt === 'string' &&
    Number.isFinite(Date.parse(applicationData.termsAcceptedAt)) &&
    snapshot.productId === productId &&
    snapshot.requestedPrincipalKes === requestedPrincipalKes &&
    typeof snapshot.termsVersion === 'string' &&
    snapshot.termsVersion.length > 0;
}

function isRetryableFeeAttempt(attempt: {
  status: PaymentStatus;
  failureCode: string | null;
  receiptReference: string | null;
} | undefined): boolean {
  return attempt?.status === PaymentStatus.FAILED &&
    attempt.receiptReference === null &&
    (
      (/^MPESA_RESULT_[1-9]\d*$/.test(attempt.failureCode ?? '') &&
        attempt.failureCode !== 'MPESA_RESULT_4999') ||
      /^MPESA_PREFLIGHT_[A-Z_]+$/.test(attempt.failureCode ?? '') ||
      attempt.failureCode === 'MPESA_STK_REJECTED'
    );
}

@Injectable()
export class PaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mpesa: MpesaService,
    private readonly ledger: LedgerService,
  ) {}

  async getLoanProcessingFeeQuote() {
    const policy = getLoanProcessingFeePolicy();
    const [revenueSetting, chargesSetting, clearing] = await Promise.all([
      this.prisma.systemSetting.findUnique({ where: { key: 'loan.processing_fee_revenue_account' } }),
      this.prisma.systemSetting.findUnique({ where: { key: 'loan.charges_revenue_account' } }),
      this.prisma.ledgerAccount.findUnique({ where: { code: 'MPESA_CLEARING' } }),
    ]);
    const revenueCode = typeof revenueSetting?.value === 'string' ? revenueSetting.value : null;
    const chargesRevenueCode = typeof chargesSetting?.value === 'string' ? chargesSetting.value : null;
    const revenue = revenueCode
      ? await this.prisma.ledgerAccount.findUnique({ where: { code: revenueCode } })
      : null;
    const unavailableReasons: string[] = [];
    if (policy.status !== 'CONFIGURED') {
      unavailableReasons.push('Approved processing-fee policy approval, version, or customer disclosure is not configured.');
    }
    if (!clearing?.isActive || clearing.currency !== 'KES' || clearing.accountType !== LedgerAccountType.ASSET) {
      unavailableReasons.push('An active KES M-Pesa clearing asset account is required.');
    }
    if (!revenueCode) {
      unavailableReasons.push('An active KES processing-fee revenue account has not been configured by an administrator.');
    } else if (!revenue?.isActive || revenue.currency !== 'KES' ||
      revenue.accountType !== LedgerAccountType.REVENUE || revenueCode === chargesRevenueCode) {
      unavailableReasons.push('The configured processing-fee destination must be an active KES revenue account.');
    }
    try {
      this.mpesa.assertConfiguredForPayments();
      buildMpesaCallbackUrl('readinesschecktoken');
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      const response = error.getResponse();
      if (typeof response === 'string') unavailableReasons.push(response);
      else if (typeof response === 'object' && response !== null && 'message' in response) {
        const message = response.message;
        unavailableReasons.push(Array.isArray(message) ? message.join(' ') : String(message));
      } else {
        unavailableReasons.push(error.message);
      }
    }
    return {
      amountKes: LOAN_PROCESSING_FEE_KES,
      currency: 'KES',
      refundPolicyStatus: policy.status,
      refundPolicyVersion: policy.version,
      refundPolicyDisclosure: policy.disclosure,
      paymentAvailable: unavailableReasons.length === 0,
      unavailableReasons,
    };
  }

  async getWalletDepositQuote(amountKes?: number) {
    const [configuration, clearingAccount, walletLiability] = await Promise.all([
      this.getWalletDepositConfiguration(),
      this.prisma.ledgerAccount.findUnique({
        where: { code: MPESA_CLEARING_ACCOUNT_CODE },
        select: { isActive: true, currency: true, accountType: true },
      }),
      this.prisma.ledgerAccount.findUnique({
        where: { code: CUSTOMER_WALLET_LIABILITY_ACCOUNT_CODE },
        select: { isActive: true, currency: true, accountType: true },
      }),
    ]);
    const unavailableReasons: string[] = [];
    if (!configuration.limits) {
      unavailableReasons.push('Approved wallet-deposit minimum and maximum amounts are not configured.');
    }
    if (!configuration.productApproved) {
      unavailableReasons.push('Wallet deposits are awaiting verified Safaricom production-product approval.');
    }
    if (!clearingAccount?.isActive || clearingAccount.currency !== 'KES' ||
      clearingAccount.accountType !== LedgerAccountType.ASSET) {
      unavailableReasons.push('An active KES M-Pesa clearing asset account is required.');
    }
    if (!walletLiability?.isActive || walletLiability.currency !== 'KES' ||
      walletLiability.accountType !== LedgerAccountType.LIABILITY) {
      unavailableReasons.push('An active KES customer-wallet liability account is required.');
    }
    try {
      this.mpesa.assertConfiguredForPayments();
      buildMpesaCallbackUrl('readinesschecktoken');
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      const response = error.getResponse();
      if (typeof response === 'string') unavailableReasons.push(response);
      else if (typeof response === 'object' && response !== null && 'message' in response) {
        const message = response.message;
        unavailableReasons.push(Array.isArray(message) ? message.join(' ') : String(message));
      } else unavailableReasons.push(error.message);
    }
    if (amountKes !== undefined) {
      if (!Number.isSafeInteger(amountKes) || amountKes <= 0 || amountKes > MAX_WALLET_DEPOSIT_AMOUNT_KES) {
        throw new BadRequestException('Enter a positive whole-KSh deposit amount.');
      }
      if (unavailableReasons.length > 0 || !configuration.limits) {
        throw new ServiceUnavailableException('Wallet deposits are currently unavailable.');
      }
      if (amountKes < configuration.limits.minimumAmountKes ||
        amountKes > configuration.limits.maximumAmountKes) {
        throw new BadRequestException('The deposit amount is outside the configured wallet limits.');
      }
    }
    return {
      currency: 'KES',
      minimumAmountKes: configuration.limits?.minimumAmountKes ?? null,
      maximumAmountKes: configuration.limits?.maximumAmountKes ?? null,
      depositAvailable: unavailableReasons.length === 0,
      unavailableReasons,
    };
  }

  async getWalletDepositEligibility(userId: string) {
    const pendingDeposit = await this.prisma.paymentTransaction.findFirst({
      where: { userId, type: PaymentType.WALLET_DEPOSIT, status: PaymentStatus.PENDING },
      orderBy: { createdAt: 'asc' },
      select: {
        internalReference: true,
        amountKes: true,
        currency: true,
        status: true,
        createdAt: true,
      },
    });
    if (!pendingDeposit) {
      return { canInitiateNewDeposit: true, pendingDeposit: null, message: null };
    }
    return {
      canInitiateNewDeposit: false,
      pendingDeposit: {
        reference: pendingDeposit.internalReference,
        amountKes: pendingDeposit.amountKes,
        currency: pendingDeposit.currency,
        status: pendingDeposit.status,
        createdAt: pendingDeposit.createdAt,
      },
      message: 'A previous wallet deposit remains unresolved. A new deposit is unavailable until its outcome is verified.',
    };
  }

  async initiateWalletDeposit(
    userId: string,
    dto: WalletDepositDto,
    idempotencyKey: string | undefined,
  ) {
    if (!Number.isSafeInteger(dto.amountKes) || dto.amountKes <= 0) {
      throw new BadRequestException('Enter a positive whole-KSh deposit amount.');
    }
    const configuration = await this.getWalletDepositConfiguration();
    const limits = configuration.limits;
    if (!limits) {
      throw new ServiceUnavailableException('Approved wallet-deposit amount limits are not configured.');
    }
    if (!configuration.productApproved) {
      throw new ServiceUnavailableException('The configured M-Pesa business product has not been confirmed for customer wallet deposits.');
    }
    if (dto.amountKes < limits.minimumAmountKes || dto.amountKes > limits.maximumAmountKes) {
      throw new BadRequestException('The deposit amount is outside the configured wallet limits.');
    }
    const phoneNumber = normalizeKenyaPhone(dto.mpesaPhoneNumber);
    if (!idempotencyKey || !/^[a-zA-Z0-9._:-]{16,128}$/.test(idempotencyKey)) {
      throw new BadRequestException('A valid Idempotency-Key header is required.');
    }
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ userId, amountKes: dto.amountKes, currency: 'KES', phoneNumber }))
      .digest('hex');
    const scopedKey = `wallet-deposit:${createHash('sha256').update(`${userId}:${idempotencyKey}`).digest('hex')}`;
    const existing = await this.prisma.paymentTransaction.findUnique({ where: { idempotencyKey: scopedKey } });
    if (existing) return this.assertWalletDepositReplay(existing, userId, requestHash);

    const [user, clearingAccount, walletLiability] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { isActive: true } }),
      this.prisma.ledgerAccount.findUnique({ where: { code: MPESA_CLEARING_ACCOUNT_CODE } }),
      this.prisma.ledgerAccount.findUnique({ where: { code: CUSTOMER_WALLET_LIABILITY_ACCOUNT_CODE } }),
    ]);
    if (!user?.isActive) throw new ForbiddenException('This account cannot initiate a wallet deposit.');
    if (!clearingAccount?.isActive || clearingAccount.currency !== 'KES' ||
      clearingAccount.accountType !== LedgerAccountType.ASSET) {
      throw new ServiceUnavailableException('Wallet deposit clearing account is unavailable.');
    }
    if (!walletLiability?.isActive || walletLiability.currency !== 'KES' ||
      walletLiability.accountType !== LedgerAccountType.LIABILITY) {
      throw new ServiceUnavailableException('Wallet deposit liability account is unavailable.');
    }
    this.mpesa.assertConfiguredForPayments();
    const callbackToken = randomBytes(32).toString('base64url');
    const callbackUrl = buildMpesaCallbackUrl(callbackToken);
    let payment: { id: string; internalReference: string };
    try {
      const started = await this.prisma.$transaction(async (tx) => {
        const replay = await tx.paymentTransaction.findUnique({ where: { idempotencyKey: scopedKey } });
        if (replay) return {
          payment: null,
          result: this.assertWalletDepositReplay(replay, userId, requestHash),
          created: false,
        };
        const unresolved = await tx.paymentTransaction.findFirst({
          where: { userId, type: PaymentType.WALLET_DEPOSIT, status: PaymentStatus.PENDING },
          orderBy: { createdAt: 'asc' },
        });
        if (unresolved) {
          return {
            payment: null,
            result: {
              reference: unresolved.internalReference,
              status: unresolved.status,
              amountKes: unresolved.amountKes,
              currency: unresolved.currency,
              message: 'A previous wallet deposit remains unresolved. A new deposit is unavailable until its outcome is verified.',
            },
            created: false,
          };
        }
        const created = await tx.paymentTransaction.create({
          data: {
            internalReference: `LPD${randomBytes(16).toString('hex').toUpperCase()}`,
            idempotencyKey: scopedKey,
            requestHash,
            userId,
            type: PaymentType.WALLET_DEPOSIT,
            amountKes: dto.amountKes,
            currency: 'KES',
            initiationPhase: 'CREATED',
            activationRequest: {
              create: {
                userId,
                callbackTokenHash: hashToken(callbackToken),
                phoneNumberCiphertext: encryptSensitiveValue(phoneNumber),
                policySnapshot: {
                  purpose: 'WALLET_DEPOSIT',
                  amountKes: dto.amountKes,
                  currency: 'KES',
                },
                expiresAt: new Date(Date.now() + 15 * 60 * 1000),
              },
            },
          },
          select: { id: true, internalReference: true },
        });
        return { payment: created, result: null, created: true };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      if (!started.created) return started.result!;
      if (!started.payment) throw new ConflictException('Wallet deposit request was not persisted.');
      payment = started.payment;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2002' || error.code === 'P2034')) {
        const [replay, unresolved] = await Promise.all([
          this.prisma.paymentTransaction.findUnique({ where: { idempotencyKey: scopedKey } }),
          this.prisma.paymentTransaction.findFirst({
            where: { userId, type: PaymentType.WALLET_DEPOSIT, status: PaymentStatus.PENDING },
            orderBy: { createdAt: 'asc' },
          }),
        ]);
        if (replay) return this.assertWalletDepositReplay(replay, userId, requestHash);
        if (unresolved) {
          return {
            reference: unresolved.internalReference,
            status: unresolved.status,
            amountKes: unresolved.amountKes,
            currency: unresolved.currency,
            message: 'A previous wallet deposit remains unresolved. A new deposit is unavailable until its outcome is verified.',
          };
        }
      }
      throw error;
    }

    let initiationStep = 'PERSIST_OAUTH_REQUESTED';
    let providerRequest: { checkoutRequestId: string; merchantRequestId: string };
    try {
      await this.prisma.paymentTransaction.updateMany({
        where: { id: payment.id, status: PaymentStatus.PENDING },
        data: { initiationPhase: 'OAUTH_REQUESTED' },
      });
      providerRequest = await this.mpesa.initiateStkPush({
        amountKes: dto.amountKes,
        phoneNumber: phoneNumber.slice(1),
        accountReference: payment.internalReference.slice(-12),
        description: 'Wallet topup',
        callbackUrl,
      }, async () => {
        initiationStep = 'PERSIST_STK_REQUESTED';
        await this.prisma.paymentTransaction.updateMany({
          where: { id: payment.id, status: PaymentStatus.PENDING },
          data: { initiationPhase: 'STK_REQUESTED' },
        });
        initiationStep = 'STK_REQUEST';
      });
    } catch (error) {
      const isPreflightFailure = error instanceof StkPushPreflightError;
      const initiationError = error instanceof StkPushInitiationError ? error : null;
      const isDefinitiveFailure = isPreflightFailure ||
        initiationError?.phase === 'CONFIGURATION' ||
        initiationError?.phase === 'OAUTH' ||
        initiationError?.phase === 'STK_REJECTED';
      if (isDefinitiveFailure) {
        const failureCode = isPreflightFailure
          ? `MPESA_PREFLIGHT_${error.reasonCode}`
          : initiationError?.phase === 'STK_REJECTED'
            ? 'MPESA_STK_REJECTED'
            : initiationError?.phase === 'OAUTH'
              ? 'MPESA_OAUTH_FAILED'
              : 'MPESA_CONFIGURATION_FAILED';
        const failureStage = isPreflightFailure ? 'LOCAL_PREFLIGHT' : initiationError!.phase;
        await this.prisma.paymentTransaction.updateMany({
          where: { id: payment.id, status: PaymentStatus.PENDING },
          data: {
            status: PaymentStatus.FAILED,
            failureCode,
            initiationPhase: failureStage,
          },
        });
        logger.warn(JSON.stringify({
          event: 'wallet_deposit_initiation_failed',
          paymentReference: payment.internalReference,
          failureStage,
          initiationStep,
          outcome: 'DEFINITE_FAILURE_BEFORE_PAYMENT_CONFIRMATION',
          providerHttpStatus: initiationError?.providerHttpStatus ?? null,
          providerResponseCode: initiationError?.providerResponseCode ?? null,
          providerDescription: initiationError?.providerDescription ?? null,
          providerFailureStage: initiationError?.providerFailureStage ?? null,
          localReasonCode: isPreflightFailure ? error.reasonCode : null,
        }));
        return {
          reference: payment.internalReference,
          status: PaymentStatus.FAILED,
          amountKes: dto.amountKes,
          currency: 'KES',
          message: isPreflightFailure
            ? 'The payment details could not be validated locally. Review the amount and phone number before retrying.'
            : initiationError?.phase === 'STK_REJECTED'
              ? 'The M-Pesa request was rejected before a payment could be confirmed. Review the payment details before retrying.'
              : 'M-Pesa could not authenticate the request, so no payment prompt was sent. Try again later or contact support.',
        };
      }
      const initiationPhase = initiationError
        ? initiationError.phase === 'STK_REQUEST'
          ? 'STK_REQUEST_OUTCOME_UNCERTAIN'
          : 'STK_RESPONSE_UNCERTAIN'
        : 'INITIATION_OUTCOME_UNCERTAIN';
      await this.prisma.paymentTransaction.updateMany({
        where: { id: payment.id, status: PaymentStatus.PENDING },
        data: { failureCode: 'INITIATION_OUTCOME_UNCERTAIN', initiationPhase },
      });
      logger.warn(JSON.stringify({
        event: 'wallet_deposit_initiation_unresolved',
        paymentReference: payment.internalReference,
        failureStage: initiationError?.phase ?? initiationStep,
        initiationPhase,
        initiationStep,
        providerHttpStatus: initiationError?.providerHttpStatus ?? null,
        providerResponseCode: initiationError?.providerResponseCode ?? null,
        providerDescription: initiationError?.providerDescription ?? null,
        providerFailureStage: initiationError?.providerFailureStage ?? null,
        errorType: error instanceof Error ? error.constructor.name : 'Unknown',
      }));
      return {
        reference: payment.internalReference,
        status: PaymentStatus.PENDING,
        amountKes: dto.amountKes,
        currency: 'KES',
        message: 'The M-Pesa request outcome remains unresolved. A new deposit is unavailable until its outcome is verified.',
      };
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        const bound = await tx.activationPaymentRequest.updateMany({
          where: {
            paymentTransactionId: payment.id,
            OR: [
              { checkoutRequestId: null, merchantRequestId: null },
              {
                checkoutRequestId: providerRequest.checkoutRequestId,
                merchantRequestId: providerRequest.merchantRequestId,
              },
            ],
          },
          data: {
            checkoutRequestId: providerRequest.checkoutRequestId,
            merchantRequestId: providerRequest.merchantRequestId,
          },
        });
        if (bound.count !== 1) throw new ConflictException('Provider identifiers could not be safely associated with this wallet deposit.');
        await tx.paymentTransaction.updateMany({
          where: { id: payment.id, status: PaymentStatus.PENDING },
          data: { initiationPhase: 'PROVIDER_ACCEPTED' },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      await this.prisma.paymentTransaction.updateMany({
        where: { id: payment.id, status: PaymentStatus.PENDING },
        data: { failureCode: 'INITIATION_OUTCOME_UNCERTAIN', initiationPhase: 'PROVIDER_IDS_NOT_PERSISTED' },
      });
      logger.warn(`Wallet STK identifiers could not be persisted for payment ${payment.internalReference} (errorType=${error instanceof Error ? error.constructor.name : 'Unknown'}).`);
      return {
        reference: payment.internalReference,
        status: PaymentStatus.PENDING,
        amountKes: dto.amountKes,
        currency: 'KES',
        message: 'Safaricom accepted the request but its identifiers could not be saved. The payment remains unresolved; do not submit another deposit.',
      }
    }
    return {
      reference: payment.internalReference,
      status: PaymentStatus.PENDING,
      amountKes: dto.amountKes,
      currency: 'KES',
      message: 'Check your phone for the M-Pesa prompt. Your wallet will be credited only after verified payment confirmation.',
    };
  }

  async initiateLoanProcessingFee(userId: string, dto: InitiateLoanProcessingFeeDto, idempotencyKey: string | undefined) {
    if (dto.reviewConfirmed !== true) {
      throw new BadRequestException('Review the application details before requesting the processing-fee payment.');
    }
    const phoneNumber = normalizeKenyaPhone(dto.mpesaPhoneNumber);
    if (!idempotencyKey || !/^[a-zA-Z0-9._:-]{16,128}$/.test(idempotencyKey)) {
      throw new BadRequestException('A valid Idempotency-Key header is required.');
    }
    const requestHash = createHash('sha256')
      .update(JSON.stringify({
        userId,
        applicationId: dto.applicationId,
        amountKes: LOAN_PROCESSING_FEE_KES,
        reviewConfirmed: true,
        mpesaPhoneNumber: phoneNumber,
      }))
      .digest('hex');
    const scopedKey = `loan-processing:${createHash('sha256').update(`${userId}:${dto.applicationId}:${idempotencyKey}`).digest('hex')}`;
    const existing = await this.prisma.paymentTransaction.findUnique({ where: { idempotencyKey: scopedKey } });
    if (existing) {
      if (
        existing.userId !== userId ||
        existing.type !== PaymentType.LOAN_PROCESSING_FEE ||
        existing.loanApplicationId !== dto.applicationId ||
        existing.requestHash !== requestHash
      ) {
        throw new ConflictException('The idempotency key has already been used.');
      }
      return {
        reference: existing.internalReference,
        status: existing.status,
        amountKes: existing.amountKes,
        currency: existing.currency,
        message: 'This application already has a processing-fee payment attempt. Its outcome must be resolved before another payment is considered.',
      };
    }
    const feePolicy = getLoanProcessingFeePolicy();
    if (feePolicy.status !== 'CONFIGURED' || !feePolicy.version || !feePolicy.disclosure) {
      throw new ServiceUnavailableException('Approved loan processing-fee policy is not configured.');
    }

    const [user, application, revenueSetting, chargesSetting] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { isActive: true } }),
      this.prisma.loanApplication.findFirst({
        where: { id: dto.applicationId, userId },
        select: {
          id: true,
          productId: true,
          requestedPrincipalKes: true,
          applicationData: true,
          status: true,
          processingFeePayments: {
            where: { type: PaymentType.LOAN_PROCESSING_FEE },
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              userId: true,
              internalReference: true,
              status: true,
              amountKes: true,
              currency: true,
              failureCode: true,
              receiptReference: true,
            },
          },
        },
      }),
      this.prisma.systemSetting.findUnique({ where: { key: 'loan.processing_fee_revenue_account' } }),
      this.prisma.systemSetting.findUnique({ where: { key: 'loan.charges_revenue_account' } }),
    ]);
    if (!user || !user.isActive) throw new ForbiddenException('This account cannot apply for a loan.');
    if (!application) throw new NotFoundException('Loan application was not found.');
    const outstandingLoan = await this.prisma.loan.findFirst({
      where: { userId, status: { in: OUTSTANDING_LOAN_STATUSES } },
      select: { id: true },
    });
    if (outstandingLoan) {
      throw new ConflictException(
        'An outstanding disbursed loan is recorded for this account. Review your loan status in My Account or contact support before paying a new application fee.',
      );
    }
    if (!hasAcceptedProductTerms(application.applicationData, application.productId, application.requestedPrincipalKes)) {
      throw new ConflictException('This application has no recorded acceptance of its product terms. Review and submit a new application before paying.');
    }
    const attempts = application.processingFeePayments;
    if (attempts.some((attempt) => attempt.userId !== userId)) {
      throw new ConflictException('This application has a fee-payment record with an invalid customer association. Contact support.');
    }
    const latestAttempt = attempts[0];
    const unresolvedAttempt = attempts.find((attempt) =>
      attempt.status === PaymentStatus.PENDING ||
      (attempt.status === PaymentStatus.FAILED &&
        attempt.failureCode === 'MPESA_RESULT_4999' &&
        attempt.receiptReference === null),
    );
    const confirmedAttempt = attempts.find((attempt) => attempt.status === PaymentStatus.CONFIRMED);
    const retryableFailure = isRetryableFeeAttempt(latestAttempt);
    if (unresolvedAttempt || confirmedAttempt || (latestAttempt && !retryableFailure)) {
      const existingAttempt = unresolvedAttempt ?? confirmedAttempt ?? latestAttempt;
      return {
        reference: existingAttempt.internalReference,
        status: existingAttempt.status,
        amountKes: existingAttempt.amountKes,
        currency: existingAttempt.currency,
        message: 'This application already has a processing-fee payment attempt. Its outcome must be resolved before another payment is considered.',
      };
    }
    if (application.status !== 'DRAFT' && !(application.status === 'PROCESSING_PAYMENT_PENDING' && retryableFailure)) {
      throw new ConflictException('Only an unpaid draft application can begin processing-fee payment.');
    }
    const revenueCode = typeof revenueSetting?.value === 'string' ? revenueSetting.value : null;
    if (!revenueCode || (typeof chargesSetting?.value === 'string' && chargesSetting.value === revenueCode)) {
      throw new ServiceUnavailableException('Separate loan processing-fee accounting is not configured.');
    }
    const [clearingAccount, revenueAccount] = await Promise.all([
      this.prisma.ledgerAccount.findUnique({ where: { code: 'MPESA_CLEARING' } }),
      this.prisma.ledgerAccount.findUnique({ where: { code: revenueCode } }),
    ]);
    if (
      !clearingAccount?.isActive || clearingAccount.currency !== 'KES' || clearingAccount.accountType !== LedgerAccountType.ASSET ||
      !revenueAccount?.isActive || revenueAccount.currency !== 'KES' || revenueAccount.accountType !== LedgerAccountType.REVENUE
    ) {
      throw new ServiceUnavailableException('Loan processing-fee ledger accounts are unavailable.');
    }
    const callbackToken = randomBytes(32).toString('base64url');
    const callbackUrl = buildMpesaCallbackUrl(callbackToken);
    this.mpesa.assertConfiguredForPayments();
    let payment: { id: string; internalReference: string };
    try {
      payment = await this.prisma.$transaction(async (tx) => {
        const currentAttempts = await tx.paymentTransaction.findMany({
          where: {
            loanApplicationId: application.id,
            type: PaymentType.LOAN_PROCESSING_FEE,
          },
          orderBy: { createdAt: 'desc' },
          select: {
            userId: true,
            internalReference: true,
            status: true,
            failureCode: true,
            amountKes: true,
            currency: true,
            receiptReference: true,
          },
        });
        const transactionOutstandingLoan = await tx.loan.findFirst({
          where: { userId, status: { in: OUTSTANDING_LOAN_STATUSES } },
          select: { id: true },
        });
        if (transactionOutstandingLoan) {
          throw new ConflictException(
            'An outstanding disbursed loan is recorded for this account. Review your loan status in My Account or contact support before paying a new application fee.',
          );
        }
        if (currentAttempts.some((attempt) => attempt.userId !== userId)) {
          throw new ConflictException('This application has a fee-payment record with an invalid customer association. Contact support.');
        }
        const activeAttempt = currentAttempts.find((attempt) =>
          attempt.status === PaymentStatus.PENDING ||
          attempt.status === PaymentStatus.CONFIRMED ||
          (attempt.status === PaymentStatus.FAILED &&
            attempt.failureCode === 'MPESA_RESULT_4999' &&
            attempt.receiptReference === null),
        );
        const latest = currentAttempts[0];
        const mayRetry = isRetryableFeeAttempt(latest);
        if (activeAttempt || (latest && !mayRetry)) {
          throw new ConflictException('This application already has a payment attempt that cannot safely be retried.');
        }
        const claimed = await tx.loanApplication.updateMany({
          where: { id: application.id, userId, status: { in: ['DRAFT', 'PROCESSING_PAYMENT_PENDING'] } },
          data: { status: 'PROCESSING_PAYMENT_PENDING' },
        });
        if (claimed.count !== 1) throw new ConflictException('This application already has a payment attempt or has been submitted.');
        const created = await tx.paymentTransaction.create({
          data: {
            internalReference: `LPP${randomBytes(16).toString('hex').toUpperCase()}`,
            idempotencyKey: scopedKey,
            requestHash,
            userId,
            type: PaymentType.LOAN_PROCESSING_FEE,
            loanApplicationId: application.id,
            amountKes: LOAN_PROCESSING_FEE_KES,
            initiationPhase: 'CREATED',
            activationRequest: {
              create: {
                userId,
                callbackTokenHash: hashToken(callbackToken),
                phoneNumberCiphertext: encryptSensitiveValue(phoneNumber),
                policySnapshot: {
                  purpose: 'LOAN_PROCESSING_FEE',
                  amountKes: LOAN_PROCESSING_FEE_KES,
                  currency: 'KES',
                  termsVersion: feePolicy.version,
                  customerDisclosure: feePolicy.disclosure,
                },
                expiresAt: new Date(Date.now() + 15 * 60 * 1000),
              },
            },
          },
          select: { id: true, internalReference: true },
        });
        await tx.idempotencyRecord.create({
          data: {
            scope: 'LOAN_PROCESSING_FEE',
            key: scopedKey,
            userId,
            paymentTransactionId: created.id,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
        });
        return created;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2002' || error.code === 'P2034')) {
        const current = await this.prisma.loanApplication.findFirst({
          where: { id: dto.applicationId, userId },
          select: {
            processingFeePayments: {
              where: { type: PaymentType.LOAN_PROCESSING_FEE },
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { internalReference: true, status: true, amountKes: true, currency: true },
            },
          },
        });
        const currentAttempt = current?.processingFeePayments[0];
        if (currentAttempt) {
          return {
            reference: currentAttempt.internalReference,
            status: currentAttempt.status,
            amountKes: currentAttempt.amountKes,
            currency: currentAttempt.currency,
            message: 'This application already has a processing-fee payment attempt. Its outcome must be resolved before another payment is considered.',
          };
        }
      }
      throw error;
    }

    let initiationStep = 'PERSIST_OAUTH_REQUESTED';
    let providerRequest: { checkoutRequestId: string; merchantRequestId: string };
    try {
      await this.prisma.paymentTransaction.updateMany({
        where: { id: payment.id, status: PaymentStatus.PENDING },
        data: { initiationPhase: 'OAUTH_REQUESTED' },
      });
      initiationStep = 'MPESA_PREFLIGHT';
      providerRequest = await this.mpesa.initiateStkPush({
        amountKes: LOAN_PROCESSING_FEE_KES,
        phoneNumber: phoneNumber.slice(1),
        accountReference: payment.internalReference.slice(-12),
        description: 'Loan fee',
        callbackUrl,
      }, async () => {
        initiationStep = 'PERSIST_STK_REQUESTED';
        await this.prisma.paymentTransaction.updateMany({
          where: { id: payment.id, status: PaymentStatus.PENDING },
          data: { initiationPhase: 'STK_REQUESTED' },
        });
        initiationStep = 'STK_REQUEST';
      });
    } catch (error) {
      if (error instanceof StkPushPreflightError) {
        const failureCode = `MPESA_PREFLIGHT_${error.reasonCode}`;
        await this.prisma.paymentTransaction.updateMany({
          where: { id: payment.id, status: PaymentStatus.PENDING },
          data: { status: PaymentStatus.FAILED, failureCode, initiationPhase: 'PREFLIGHT_FAILED' },
        });
        logger.warn(JSON.stringify({
          event: 'mpesa_stk_preflight_failed',
          paymentId: payment.id,
          paymentReference: payment.internalReference,
          phase: 'PRE_PROVIDER',
          step: 'MPESA_PREFLIGHT',
          reasonCode: error.reasonCode,
          providerRequestSent: false,
        }));
        return {
          reference: payment.internalReference,
          status: PaymentStatus.FAILED,
          amountKes: LOAN_PROCESSING_FEE_KES,
          currency: 'KES',
          message: 'The payment request failed local validation and no M-Pesa request was sent. Review the application and try again.',
        };
      }
      if (error instanceof StkPushInitiationError && error.phase === 'STK_REJECTED') {
        await this.prisma.paymentTransaction.updateMany({
          where: { id: payment.id, status: PaymentStatus.PENDING },
          data: { status: PaymentStatus.FAILED, failureCode: 'MPESA_STK_REJECTED', initiationPhase: 'STK_REJECTED' },
        });
        logger.warn(JSON.stringify({
          event: 'mpesa_stk_request_rejected',
          paymentId: payment.id,
          paymentReference: payment.internalReference,
          phase: 'PROVIDER_RESPONSE',
          step: 'STK_REQUEST',
          reasonCode: 'PROVIDER_REJECTED_REQUEST',
          providerResponseCode: error.providerResponseCode,
        }));
        return {
          reference: payment.internalReference,
          status: PaymentStatus.FAILED,
          amountKes: LOAN_PROCESSING_FEE_KES,
          currency: 'KES',
          message: 'M-Pesa rejected the request before accepting a payment prompt. Review the payment details before trying again.',
        };
      }
      const initiationPhase = error instanceof StkPushInitiationError
        ? error.phase === 'OAUTH'
          ? 'OAUTH_FAILED_BEFORE_STK'
          : error.phase === 'STK_REQUEST'
            ? 'STK_REQUEST_OUTCOME_UNCERTAIN'
            : 'STK_RESPONSE_UNCERTAIN'
        : 'INITIATION_OUTCOME_UNCERTAIN';
      const phase = error instanceof StkPushInitiationError
        ? error.phase
        : initiationStep === 'PERSIST_STK_REQUESTED'
          ? 'OAUTH_SUCCEEDED_BEFORE_STK'
          : 'PRE_PROVIDER';
      await this.prisma.paymentTransaction.updateMany({
        where: { id: payment.id, status: PaymentStatus.PENDING },
        data: { failureCode: 'INITIATION_OUTCOME_UNCERTAIN', initiationPhase },
      });
      logger.warn(`STK initiation outcome uncertain for payment ${payment.internalReference} (phase=${phase}; step=${initiationStep}; errorType=${error instanceof Error ? error.constructor.name : 'Unknown'}).`);
      return {
        reference: payment.internalReference,
        status: PaymentStatus.PENDING,
        amountKes: LOAN_PROCESSING_FEE_KES,
        currency: 'KES',
        message: 'The payment request outcome is being checked. Do not submit another payment while it remains unresolved.',
      };
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        const requestBinding = await tx.activationPaymentRequest.updateMany({
          where: {
            paymentTransactionId: payment.id,
            OR: [
              { checkoutRequestId: null, merchantRequestId: null },
              {
                checkoutRequestId: providerRequest.checkoutRequestId,
                merchantRequestId: providerRequest.merchantRequestId,
              },
            ],
          },
          data: {
            checkoutRequestId: providerRequest.checkoutRequestId,
            merchantRequestId: providerRequest.merchantRequestId,
          },
        });
        if (requestBinding.count !== 1) {
          throw new ConflictException('Provider identifiers could not be safely associated with the payment.');
        }
        await tx.paymentTransaction.updateMany({
          where: { id: payment.id, status: PaymentStatus.PENDING },
          data: { initiationPhase: 'PROVIDER_ACCEPTED' },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      let unresolvedMarkerPersisted = false;
      let markerErrorType = 'None';
      try {
        const markedUnresolved = await this.prisma.paymentTransaction.updateMany({
          where: { id: payment.id, status: PaymentStatus.PENDING },
          data: {
            failureCode: 'INITIATION_OUTCOME_UNCERTAIN',
            initiationPhase: 'PROVIDER_IDS_NOT_PERSISTED',
          },
        });
        unresolvedMarkerPersisted = markedUnresolved.count === 1;
      } catch (markerError) {
        markerErrorType = markerError instanceof Error ? markerError.constructor.name : 'Unknown';
      }
      logger.warn(`STK identifiers could not be persisted for payment ${payment.internalReference} (phase=PROVIDER_ACCEPTED; step=PERSIST_PROVIDER_IDENTIFIERS; unresolvedMarkerPersisted=${unresolvedMarkerPersisted}; errorType=${error instanceof Error ? error.constructor.name : 'Unknown'}; markerErrorType=${markerErrorType}).`);
      return {
        reference: payment.internalReference,
        status: PaymentStatus.PENDING,
        amountKes: LOAN_PROCESSING_FEE_KES,
        currency: 'KES',
        message: 'Safaricom returned a payment request response, but its identifiers could not be saved. The payment remains unresolved; do not submit another payment while it is being reconciled.',
      };
    }

    return {
      reference: payment.internalReference,
      status: PaymentStatus.PENDING,
      amountKes: LOAN_PROCESSING_FEE_KES,
      currency: 'KES',
      message: 'Check your phone for the M-Pesa prompt. The application will be submitted only after verified payment confirmation.',
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
        initiationPhase: true,
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
        unresolved: (payment.type === PaymentType.LOAN_PROCESSING_FEE ||
          payment.type === PaymentType.WALLET_DEPOSIT) && status === PaymentStatus.PENDING,
        providerResult: {
          code: resultCode,
          message: this.getCustomerPaymentMessage(status, resultCode, failureCode),
        },
      };
    });
  }

  async getWalletDepositStatus(userId: string, reference: string) {
    const payment = await this.prisma.paymentTransaction.findFirst({
      where: { userId, type: PaymentType.WALLET_DEPOSIT, internalReference: reference },
      select: {
        internalReference: true,
        amountKes: true,
        currency: true,
        status: true,
        receiptReference: true,
        confirmedAt: true,
        createdAt: true,
      },
    });
    if (!payment) throw new NotFoundException('Wallet deposit was not found.');
    return payment;
  }

  async getUnresolvedLoanProcessingFeePayment(userId: string) {
    const payment = await this.prisma.paymentTransaction.findFirst({
      where: {
        userId,
        type: PaymentType.LOAN_PROCESSING_FEE,
        OR: [
          { status: PaymentStatus.PENDING },
          { status: PaymentStatus.FAILED, failureCode: 'MPESA_RESULT_4999', receiptReference: null },
        ],
      },
      orderBy: { createdAt: 'asc' },
      select: {
        internalReference: true,
        status: true,
        failureCode: true,
        initiationPhase: true,
        amountKes: true,
        currency: true,
        createdAt: true,
      },
    });
    if (!payment) return null;
    return {
      reference: payment.internalReference,
      status: payment.status === PaymentStatus.FAILED && payment.failureCode === 'MPESA_RESULT_4999'
        ? PaymentStatus.PENDING
        : payment.status,
      amountKes: payment.amountKes,
      currency: payment.currency,
      initiationPhase: payment.initiationPhase,
      createdAt: payment.createdAt,
      message: 'A previous processing-fee payment is unresolved. Do not pay again until it has been reconciled.',
    };
  }

  async listReconciliationQueue(
    cursor?: string,
    requestedLimit = 50,
    search?: string,
    category: ReconciliationQueueCategory = 'ALL',
  ) {
    const limit = Math.min(Math.max(Math.floor(requestedLimit || 50), 1), 100);
    const normalizedSearch = search?.trim();
    if (normalizedSearch && normalizedSearch.length > 40) {
      throw new BadRequestException('Payment reference search must be 40 characters or fewer.');
    }
    const setting = await this.prisma.systemSetting.findUnique({
      where: { key: 'payments.reconciliation.pending_minutes' },
      select: { value: true },
    });
    const configuredMinutes = typeof setting?.value === 'number' ? setting.value : 5;
    const thresholdMinutes = Number.isInteger(configuredMinutes) && configuredMinutes >= 1 && configuredMinutes <= 1440
      ? configuredMinutes
      : 5;
    const cutoff = new Date(Date.now() - thresholdMinutes * 60_000);
    const providerReviewFilter: Prisma.PaymentTransactionWhereInput = {
      status: PaymentStatus.PENDING,
      reconciliationAttempts: { some: { outcome: { in: [...PROVIDER_REVIEW_OUTCOMES] } } },
    };
    const inclusionFilter: Prisma.PaymentTransactionWhereInput = category === 'LEGACY_4999'
      ? { type: PaymentType.ACTIVATION, status: PaymentStatus.FAILED, failureCode: 'MPESA_RESULT_4999' }
      : category === 'AGED_PENDING'
        ? { status: PaymentStatus.PENDING, createdAt: { lte: cutoff } }
        : category === 'PROVIDER_REVIEW'
          ? providerReviewFilter
          : {
              OR: [
                { status: PaymentStatus.PENDING, createdAt: { lte: cutoff } },
                { status: PaymentStatus.FAILED, failureCode: 'MPESA_RESULT_4999' },
                providerReviewFilter,
              ],
            };
    const rows = await this.prisma.paymentTransaction.findMany({
      where: {
        type: { in: [PaymentType.ACTIVATION, PaymentType.LOAN_PROCESSING_FEE, PaymentType.WALLET_DEPOSIT] },
        ...inclusionFilter,
        ...(normalizedSearch ? {
          OR: [
            { internalReference: normalizedSearch },
            { providerReference: normalizedSearch },
            { receiptReference: normalizedSearch },
          ],
        } : {}),
      },
      select: {
        id: true,
        internalReference: true,
        type: true,
        amountKes: true,
        currency: true,
        status: true,
        failureCode: true,
        initiationPhase: true,
        providerReference: true,
        receiptReference: true,
        createdAt: true,
        updatedAt: true,
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
            submittedAccountReference: true,
            submittedCheckoutRequestId: true,
            submittedMerchantRequestId: true,
            evidenceSource: true,
            evidenceReference: true,
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
        const { failureCode, reconciliationAttempts, ...queuePayment } = payment;
        const safeAttempts = reconciliationAttempts.map((attempt) => attempt.outcome === 'UNRESOLVED_PROCESSING'
          ? { ...attempt, outcome: 'UNRESOLVED_4999', reasonCode: 'RESULT_4999_REMAINS_UNRESOLVED' }
          : attempt);
        const latestOutcome = safeAttempts[0]?.outcome;
        const providerReviewRequired = safeAttempts.some((item) => PROVIDER_REVIEW_OUTCOMES.has(item.outcome));
        const isLegacyUnresolved = failureCode === 'MPESA_RESULT_4999';
        const needsProviderIdentifiers =
          (payment.type === PaymentType.LOAN_PROCESSING_FEE || payment.type === PaymentType.WALLET_DEPOSIT) &&
          payment.status === PaymentStatus.PENDING &&
          (failureCode === 'INITIATION_OUTCOME_UNCERTAIN' ||
            payment.initiationPhase === 'STK_REQUESTED' ||
            payment.initiationPhase === 'PROVIDER_IDS_NOT_PERSISTED') &&
          !payment.activationRequest?.checkoutRequestId &&
          !payment.activationRequest?.merchantRequestId;
        return {
          ...queuePayment,
          needsProviderIdentifiers,
          accountReference: needsProviderIdentifiers ? payment.internalReference.slice(-12) : null,
          initiationPhase: payment.initiationPhase,
          reconciliationAttempts: safeAttempts,
          recordedStatus: payment.status,
          status: payment.status === PaymentStatus.FAILED && isLegacyUnresolved
            ? PaymentStatus.PENDING
            : payment.status,
          reasonForInclusion: isLegacyUnresolved
            ? 'LEGACY_UNRESOLVED_4999'
            : latestOutcome === 'ESCALATED'
              ? 'ESCALATED'
              : providerReviewRequired
                ? 'PROVIDER_REVIEW_REQUIRED'
                : 'AGED_PENDING',
          reconciliationStatus: isLegacyUnresolved
            ? 'LEGACY_UNRESOLVED_4999'
            : latestOutcome === 'ESCALATED'
              ? 'ESCALATED'
              : latestOutcome && PROVIDER_REVIEW_OUTCOMES.has(latestOutcome)
                ? latestOutcome
                : 'PENDING',
        };
      }),
      nextCursor: hasMore ? items.at(-1)?.id ?? null : null,
      pendingThresholdMinutes: thresholdMinutes,
      category,
    };
  }

  async reconcileActivationPayment(
    paymentId: string,
    idempotencyKey: string | undefined,
    superadminId: string,
    operatorNote: string,
    ipAddress?: string,
    providerIdentifiers?: {
      accountReference: string;
      checkoutRequestId: string;
      merchantRequestId: string;
      evidenceSource?: string;
      evidenceReference?: string;
    },
  ) {
    if (!idempotencyKey || !/^[a-zA-Z0-9._:-]{16,128}$/.test(idempotencyKey)) {
      throw new BadRequestException('A valid Idempotency-Key header is required.');
    }
    const sanitizedNote = operatorNote.trim();
    if (sanitizedNote.length < 10 || sanitizedNote.length > 500) {
      throw new BadRequestException('An investigation note between 10 and 500 characters is required.');
    }
    const submittedAccountReference = providerIdentifiers?.accountReference.trim();
    const submittedCheckoutRequestId = providerIdentifiers?.checkoutRequestId.trim();
    const submittedMerchantRequestId = providerIdentifiers?.merchantRequestId.trim();
    const evidenceSource = providerIdentifiers?.evidenceSource;
    const evidenceReference = providerIdentifiers?.evidenceReference?.trim();
    if (providerIdentifiers && (
      !submittedAccountReference || !/^[A-Za-z0-9]{12}$/.test(submittedAccountReference) ||
      !submittedCheckoutRequestId || !/^[A-Za-z0-9_-]{1,100}$/.test(submittedCheckoutRequestId) ||
      !submittedMerchantRequestId || !/^[A-Za-z0-9_-]{1,100}$/.test(submittedMerchantRequestId) ||
      (evidenceSource !== 'SAFARICOM_PORTAL' && evidenceSource !== 'SAFARICOM_SUPPORT') ||
      !evidenceReference || !/^[A-Za-z0-9._:/-]{3,100}$/.test(evidenceReference)
    )) {
      throw new BadRequestException('Both valid Safaricom request identifiers are required.');
    }
    const submittedIdentifiers = providerIdentifiers
      ? {
          accountReference: submittedAccountReference!,
          checkoutRequestId: submittedCheckoutRequestId!,
          merchantRequestId: submittedMerchantRequestId!,
          evidenceSource: evidenceSource!,
          evidenceReference: evidenceReference!,
        }
      : undefined;
    const assertSameReplay = (existing: {
      id: string;
      outcome: string;
      providerResultCode: string | null;
      reasonCode: string | null;
      operatorNote: string;
      superadminId: string;
      submittedAccountReference?: string | null;
      submittedCheckoutRequestId?: string | null;
      submittedMerchantRequestId?: string | null;
      evidenceSource?: string | null;
      evidenceReference?: string | null;
    }) => {
      if (existing.superadminId !== superadminId) {
        throw new ConflictException('This idempotency key belongs to another administrator.');
      }
      const isDifferentAction = existing.outcome === 'ESCALATED' ||
        existing.reasonCode === 'PROVIDER_INVESTIGATION_REQUIRED' ||
        existing.reasonCode === 'INDEPENDENT_PROVIDER_EVIDENCE_REVIEW' ||
        (existing.submittedAccountReference ?? null) !== (submittedIdentifiers?.accountReference ?? null) ||
        (existing.submittedCheckoutRequestId ?? null) !== (submittedIdentifiers?.checkoutRequestId ?? null) ||
        (existing.submittedMerchantRequestId ?? null) !== (submittedIdentifiers?.merchantRequestId ?? null) ||
        (existing.evidenceSource ?? null) !== (submittedIdentifiers?.evidenceSource ?? null) ||
        (existing.evidenceReference ?? null) !== (submittedIdentifiers?.evidenceReference ?? null);
      if (isDifferentAction) {
        throw new ConflictException('This idempotency key was already used for a different reconciliation action.');
      }
      return existing;
    };

    const now = new Date();
    let attempt: { id: string; outcome: string; providerResultCode: string | null; reasonCode: string | null };
    let payment: Prisma.PaymentTransactionGetPayload<{ include: { activationRequest: true; loanApplication: true } }> | null;
    try {
      const started = await this.prisma.$transaction(async (tx) => {
        const existing = await tx.paymentReconciliationAttempt.findUnique({
          where: { paymentTransactionId_idempotencyKey: { paymentTransactionId: paymentId, idempotencyKey } },
          select: {
            id: true,
            outcome: true,
            providerResultCode: true,
            reasonCode: true,
            operatorNote: true,
            superadminId: true,
            submittedAccountReference: true,
            submittedCheckoutRequestId: true,
            submittedMerchantRequestId: true,
            evidenceSource: true,
            evidenceReference: true,
          },
        });
        if (existing) {
          return { attempt: assertSameReplay(existing), payment: null, duplicate: true };
        }

        const currentPayment = await tx.paymentTransaction.findUnique({
          where: { id: paymentId },
          include: { activationRequest: true, loanApplication: true },
        });
        if (!currentPayment) throw new NotFoundException('Payment was not found.');
        this.assertPaymentAssociation(currentPayment, {
          paymentTransactionId: currentPayment.id,
          userId: currentPayment.activationRequest?.userId ?? '',
          loanApplicationId: currentPayment.loanApplicationId,
        });
        const isLegacyUnresolved =
          currentPayment.status === PaymentStatus.FAILED &&
          currentPayment.failureCode === 'MPESA_RESULT_4999' &&
          currentPayment.receiptReference === null;
        if (currentPayment.status !== PaymentStatus.PENDING && !isLegacyUnresolved) {
          throw new ConflictException('Only unresolved activation, processing-fee, or wallet-deposit payments can be reconciled.');
        }
        if (submittedIdentifiers && (
          (currentPayment.type !== PaymentType.LOAN_PROCESSING_FEE &&
            currentPayment.type !== PaymentType.WALLET_DEPOSIT) ||
          currentPayment.status !== PaymentStatus.PENDING ||
          (currentPayment.failureCode !== 'INITIATION_OUTCOME_UNCERTAIN' &&
            currentPayment.initiationPhase !== 'STK_REQUESTED' &&
            currentPayment.initiationPhase !== 'PROVIDER_IDS_NOT_PERSISTED') ||
          currentPayment.activationRequest?.checkoutRequestId !== null ||
          currentPayment.activationRequest?.merchantRequestId !== null
        )) {
          throw new ConflictException('Safaricom identifiers can only be supplied for an uncertain processing-fee or wallet-deposit initiation with no stored identifiers.');
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
          data: {
            paymentTransactionId: paymentId,
            superadminId,
            idempotencyKey,
            operatorNote: sanitizedNote,
            submittedAccountReference: submittedIdentifiers?.accountReference,
            submittedCheckoutRequestId: submittedIdentifiers?.checkoutRequestId,
            submittedMerchantRequestId: submittedIdentifiers?.merchantRequestId,
            evidenceSource: submittedIdentifiers?.evidenceSource,
            evidenceReference: submittedIdentifiers?.evidenceReference,
          },
          select: {
            id: true,
            outcome: true,
            providerResultCode: true,
            reasonCode: true,
            operatorNote: true,
            submittedAccountReference: true,
            submittedCheckoutRequestId: true,
            submittedMerchantRequestId: true,
          },
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
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2002' || error.code === 'P2034')) {
        const duplicate = await this.prisma.paymentReconciliationAttempt.findUnique({
          where: { paymentTransactionId_idempotencyKey: { paymentTransactionId: paymentId, idempotencyKey } },
          select: {
            id: true,
            outcome: true,
            providerResultCode: true,
            reasonCode: true,
            operatorNote: true,
            superadminId: true,
            submittedAccountReference: true,
            submittedCheckoutRequestId: true,
            submittedMerchantRequestId: true,
            evidenceSource: true,
            evidenceReference: true,
          },
        });
        if (duplicate) return assertSameReplay(duplicate);
        if (error.code === 'P2034') {
          throw new ConflictException('Another reconciliation request is being processed. Try again shortly.');
        }
      } else if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
        throw new ConflictException('Another reconciliation request is being processed. Try again shortly.');
      }
      throw error;
    }

    if (submittedIdentifiers && submittedIdentifiers.accountReference !== payment.internalReference.slice(-12)) {
      return this.completeReconciliationAttempt(attempt.id, paymentId, superadminId, ipAddress, {
        outcome: 'UNRESOLVED_IDENTIFIER_MISMATCH',
        reasonCode: 'SAFARICOM_ACCOUNT_REFERENCE_MISMATCH',
      });
    }
    if (submittedIdentifiers) {
      return this.completeReconciliationAttempt(attempt.id, paymentId, superadminId, ipAddress, {
        outcome: 'EVIDENCE_SUBMITTED_AWAITING_REVIEW',
        reasonCode: 'INDEPENDENT_EVIDENCE_REVIEW_REQUIRED',
      });
    }

    let activationRequest = payment.activationRequest;
    if (!activationRequest) {
      return this.completeReconciliationAttempt(attempt.id, paymentId, superadminId, ipAddress, {
        outcome: 'UNRESOLVED_MISSING_IDENTIFIERS',
        reasonCode: 'PROVIDER_REQUEST_MISSING',
      });
    }
    const activationRequestId = activationRequest.id;
    const hasStoredCheckoutId = Boolean(activationRequest.checkoutRequestId);
    const hasStoredMerchantId = Boolean(activationRequest.merchantRequestId);
    if (hasStoredCheckoutId !== hasStoredMerchantId) {
      return this.completeReconciliationAttempt(attempt.id, paymentId, superadminId, ipAddress, {
        outcome: 'UNRESOLVED_IDENTIFIER_MISMATCH',
        reasonCode: 'INCOMPLETE_STORED_PROVIDER_IDENTIFIERS',
      });
    }
    if (!hasStoredCheckoutId && !submittedIdentifiers) {
      return this.completeReconciliationAttempt(attempt.id, paymentId, superadminId, ipAddress, {
        outcome: 'UNRESOLVED_MISSING_IDENTIFIERS',
        reasonCode: 'PROVIDER_IDENTIFIERS_MISSING',
      });
    }
    const expectedIdentifiers = hasStoredCheckoutId
      ? { checkoutRequestId: activationRequest.checkoutRequestId!, merchantRequestId: activationRequest.merchantRequestId! }
      : submittedIdentifiers!;

    let providerStatus: Awaited<ReturnType<MpesaService['queryStkStatus']>>;
    try {
      providerStatus = await this.mpesa.queryStkStatus(expectedIdentifiers.checkoutRequestId);
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
      providerStatus.checkoutRequestId !== expectedIdentifiers.checkoutRequestId ||
      providerStatus.merchantRequestId !== expectedIdentifiers.merchantRequestId
    ) {
      return this.completeReconciliationAttempt(attempt.id, paymentId, superadminId, ipAddress, {
        outcome: 'UNRESOLVED_IDENTIFIER_MISMATCH',
        providerResultCode: String(providerStatus.resultCode),
        reasonCode: 'PROVIDER_IDENTIFIERS_MISMATCH',
      });
    }

    if (!hasStoredCheckoutId) {
      try {
        const identifiersBound = await this.prisma.$transaction(async (tx) => {
          const bound = await tx.activationPaymentRequest.updateMany({
            where: {
              id: activationRequestId,
              paymentTransactionId: payment.id,
              userId: payment.userId,
              checkoutRequestId: null,
              merchantRequestId: null,
            },
            data: {
              checkoutRequestId: providerStatus.checkoutRequestId,
              merchantRequestId: providerStatus.merchantRequestId,
            },
          });
          if (bound.count === 1) return true;
          const current = await tx.activationPaymentRequest.findUnique({
            where: { id: activationRequestId },
            select: { checkoutRequestId: true, merchantRequestId: true },
          });
          return current?.checkoutRequestId === providerStatus.checkoutRequestId &&
            current.merchantRequestId === providerStatus.merchantRequestId;
        });
        if (!identifiersBound) {
          return this.completeReconciliationAttempt(attempt.id, paymentId, superadminId, ipAddress, {
            outcome: 'UNRESOLVED_IDENTIFIER_MISMATCH',
            providerResultCode: String(providerStatus.resultCode),
            reasonCode: 'PROVIDER_IDENTIFIERS_CHANGED_DURING_REFRESH',
          });
        }
        activationRequest = {
          ...activationRequest,
          checkoutRequestId: providerStatus.checkoutRequestId,
          merchantRequestId: providerStatus.merchantRequestId,
        };
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          return this.completeReconciliationAttempt(attempt.id, paymentId, superadminId, ipAddress, {
            outcome: 'UNRESOLVED_IDENTIFIER_MISMATCH',
            providerResultCode: String(providerStatus.resultCode),
            reasonCode: 'PROVIDER_IDENTIFIER_ALREADY_BOUND',
          });
        }
        await this.completeReconciliationAttempt(attempt.id, paymentId, superadminId, ipAddress, {
          outcome: 'QUERY_ERROR',
          providerResultCode: String(providerStatus.resultCode),
          reasonCode: 'PROVIDER_IDENTIFIERS_NOT_PERSISTED',
        });
        throw error;
      }
    }

    if (providerStatus.resultCode === 4999) {
      return this.completeReconciliationAttempt(attempt.id, paymentId, superadminId, ipAddress, {
        outcome: 'UNRESOLVED_4999',
        providerResultCode: '4999',
        reasonCode: 'RESULT_4999_REMAINS_UNRESOLVED',
      });
    }
    if (providerStatus.resultCode === 0) {
      const isLegacyProcessingFee = payment.type === PaymentType.LOAN_PROCESSING_FEE &&
        payment.status === PaymentStatus.FAILED &&
        payment.failureCode === 'MPESA_RESULT_4999' &&
        payment.receiptReference === null;
      if (isLegacyProcessingFee) {
        const verifiedCallback = await this.prisma.paymentCallbackEvent.findFirst({
          where: {
            activationPaymentRequestId: activationRequest.id,
            paymentTransactionId: payment.id,
            providerResultCode: '0',
            providerReceiptReference: { not: null },
          },
          orderBy: { receivedAt: 'desc' },
          select: { providerReceiptReference: true },
        });
        const receiptReference = verifiedCallback?.providerReceiptReference;
        if (receiptReference && /^[A-Za-z0-9]{6,32}$/.test(receiptReference)) {
          await this.settleActivationPayment(
            payment,
            { ...activationRequest, loanApplicationId: payment.loanApplicationId },
            providerStatus,
            undefined,
            undefined,
            { legacyVerifiedReceiptReference: receiptReference },
          );
          return this.completeReconciliationAttempt(attempt.id, paymentId, superadminId, ipAddress, {
            outcome: 'RESOLVED_CONFIRMED',
            providerResultCode: '0',
            reasonCode: 'VERIFIED_CALLBACK_AND_SUCCESS_QUERY',
          });
        }
      }
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
      await this.settleActivationPayment(payment, {
        ...activationRequest,
        loanApplicationId: payment.loanApplicationId,
      }, providerStatus);
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

  async verifyUncertainProcessingFeeEvidence(
    paymentId: string,
    evidenceAttemptId: string,
    idempotencyKey: string | undefined,
    superadminId: string,
    operatorNote: string,
    evidenceReviewed: boolean,
    ipAddress?: string,
  ) {
    if (!idempotencyKey || !/^[a-zA-Z0-9._:-]{16,128}$/.test(idempotencyKey)) {
      throw new BadRequestException('A valid Idempotency-Key header is required.');
    }
    const sanitizedNote = operatorNote.trim();
    if (sanitizedNote.length < 10 || sanitizedNote.length > 500) {
      throw new BadRequestException('An evidence review note between 10 and 500 characters is required.');
    }
    if (evidenceReviewed !== true) {
      throw new BadRequestException('Confirm that the official Safaricom transaction record was reviewed.');
    }

    let started: Awaited<ReturnType<typeof startEvidenceReview>>;
    const startEvidenceReview = () => this.prisma.$transaction(async (tx) => {
      const duplicate = await tx.paymentReconciliationAttempt.findUnique({
        where: { paymentTransactionId_idempotencyKey: { paymentTransactionId: paymentId, idempotencyKey } },
        select: { id: true, outcome: true, providerResultCode: true, reasonCode: true, superadminId: true, operatorNote: true },
      });
      if (duplicate) {
        if (duplicate.superadminId !== superadminId) {
          throw new ConflictException('This idempotency key belongs to another administrator.');
        }
        if (!duplicate.operatorNote.startsWith(`Reviewed evidence ${evidenceAttemptId}:`)) {
          throw new ConflictException('This idempotency key was already used for another reconciliation action.');
        }
        return { attempt: duplicate, payment: null, request: null, duplicate: true };
      }

      const [payment, evidenceAttempt] = await Promise.all([
        tx.paymentTransaction.findUnique({
          where: { id: paymentId },
          include: { activationRequest: true },
        }),
        tx.paymentReconciliationAttempt.findUnique({
          where: { id: evidenceAttemptId },
          select: {
            id: true,
            paymentTransactionId: true,
            superadminId: true,
            outcome: true,
            submittedAccountReference: true,
            submittedCheckoutRequestId: true,
            submittedMerchantRequestId: true,
            evidenceSource: true,
            evidenceReference: true,
          },
        }),
      ]);
      if (!payment) throw new NotFoundException('Payment was not found.');
      this.assertPaymentAssociation(payment, {
        paymentTransactionId: payment.id,
        userId: payment.activationRequest?.userId ?? '',
        loanApplicationId: payment.loanApplicationId,
      });
      if (!evidenceAttempt || evidenceAttempt.paymentTransactionId !== paymentId ||
        evidenceAttempt.outcome !== 'EVIDENCE_SUBMITTED_AWAITING_REVIEW' ||
        !evidenceAttempt.submittedAccountReference || !evidenceAttempt.submittedCheckoutRequestId ||
        !evidenceAttempt.submittedMerchantRequestId || !evidenceAttempt.evidenceSource ||
        !evidenceAttempt.evidenceReference) {
        throw new ConflictException('This provider evidence is missing, invalid, or already reviewed.');
      }
      if (evidenceAttempt.superadminId === superadminId) {
        throw new ConflictException('A different Superadmin must independently review the provider evidence.');
      }
      if ((payment.type !== PaymentType.LOAN_PROCESSING_FEE &&
        payment.type !== PaymentType.WALLET_DEPOSIT) || payment.status !== PaymentStatus.PENDING ||
        (payment.failureCode !== 'INITIATION_OUTCOME_UNCERTAIN' &&
          payment.initiationPhase !== 'STK_REQUESTED' &&
          payment.initiationPhase !== 'PROVIDER_IDS_NOT_PERSISTED') ||
        evidenceAttempt.submittedAccountReference !== payment.internalReference.slice(-12) ||
        payment.activationRequest?.checkoutRequestId !== null ||
        payment.activationRequest?.merchantRequestId !== null) {
        throw new ConflictException('This payment is no longer eligible for missing-identifier evidence review.');
      }
      const request = payment.activationRequest;
      if (!request) throw new ConflictException('Payment callback request record is unavailable.');
      const recentAttempt = await tx.paymentReconciliationAttempt.findFirst({
        where: { paymentTransactionId: paymentId, outcome: 'STARTED', requestedAt: { gt: new Date(Date.now() - 60_000) } },
        select: { id: true },
      });
      if (recentAttempt) throw new ConflictException('A status refresh is already in progress for this payment.');

      const attempt = await tx.paymentReconciliationAttempt.create({
        data: {
          paymentTransactionId: paymentId,
          superadminId,
          idempotencyKey,
          operatorNote: `Reviewed evidence ${evidenceAttempt.id}: ${sanitizedNote}`.slice(0, 500),
          outcome: 'STARTED',
          reasonCode: 'INDEPENDENT_PROVIDER_EVIDENCE_REVIEW',
          submittedAccountReference: evidenceAttempt.submittedAccountReference,
          submittedCheckoutRequestId: evidenceAttempt.submittedCheckoutRequestId,
          submittedMerchantRequestId: evidenceAttempt.submittedMerchantRequestId,
          evidenceSource: evidenceAttempt.evidenceSource,
          evidenceReference: evidenceAttempt.evidenceReference,
        },
        select: { id: true, outcome: true, providerResultCode: true, reasonCode: true, operatorNote: true },
      });
      await tx.adminAuditLog.create({
        data: {
          superadminId,
          action: 'PAYMENT_RECONCILIATION_EVIDENCE_REVIEW_STARTED',
          subjectType: 'PAYMENT_TRANSACTION',
          subjectId: paymentId,
          outcome: 'STARTED',
          reason: `Independent review of provider evidence attempt ${evidenceAttempt.id}: ${sanitizedNote}`.slice(0, 500),
          ipAddress: ipAddress?.slice(0, 64),
        },
      });
      return { attempt, payment, request, evidenceAttempt, duplicate: false };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    try {
      started = await startEvidenceReview();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2002' || error.code === 'P2034')) {
        const duplicate = await this.prisma.paymentReconciliationAttempt.findUnique({
          where: { paymentTransactionId_idempotencyKey: { paymentTransactionId: paymentId, idempotencyKey } },
          select: { id: true, outcome: true, providerResultCode: true, reasonCode: true, superadminId: true, operatorNote: true },
        });
        if (duplicate) {
          if (duplicate.superadminId !== superadminId) {
            throw new ConflictException('This idempotency key belongs to another administrator.');
          }
          if (!duplicate.operatorNote.startsWith(`Reviewed evidence ${evidenceAttemptId}:`)) {
            throw new ConflictException('This idempotency key was already used for another reconciliation action.');
          }
          return duplicate;
        }
        if (error.code === 'P2034') {
          throw new ConflictException('Another evidence review request is being processed. Try again shortly.');
        }
      }
      throw error;
    }
    if (started.duplicate || !started.payment || !started.request) return started.attempt;

    let providerStatus: Awaited<ReturnType<MpesaService['queryStkStatus']>>;
    try {
      providerStatus = await this.mpesa.queryStkStatus(started.evidenceAttempt.submittedCheckoutRequestId!);
    } catch (error) {
      if (error instanceof ServiceUnavailableException || error instanceof InternalServerErrorException) {
        return this.completeReconciliationAttempt(started.attempt.id, paymentId, superadminId, ipAddress, {
          outcome: 'UNRESOLVED_PROVIDER_UNAVAILABLE',
          reasonCode: 'PROVIDER_UNAVAILABLE_DURING_EVIDENCE_REVIEW',
        });
      }
      await this.completeReconciliationAttempt(started.attempt.id, paymentId, superadminId, ipAddress, {
        outcome: 'QUERY_ERROR',
        reasonCode: 'INTERNAL_EVIDENCE_REVIEW_QUERY_ERROR',
      });
      throw error;
    }

    if (providerStatus.checkoutRequestId !== started.evidenceAttempt.submittedCheckoutRequestId ||
      providerStatus.merchantRequestId !== started.evidenceAttempt.submittedMerchantRequestId) {
      return this.completeReconciliationAttempt(started.attempt.id, paymentId, superadminId, ipAddress, {
        outcome: 'UNRESOLVED_IDENTIFIER_MISMATCH',
        providerResultCode: String(providerStatus.resultCode),
        reasonCode: 'PROVIDER_IDENTIFIERS_MISMATCH',
      });
    }

    try {
      const bound = await this.prisma.$transaction(async (tx) => {
        const result = await tx.activationPaymentRequest.updateMany({
          where: {
            id: started.request!.id,
            paymentTransactionId: paymentId,
            userId: started.payment!.userId,
            checkoutRequestId: null,
            merchantRequestId: null,
          },
          data: {
            checkoutRequestId: providerStatus.checkoutRequestId,
            merchantRequestId: providerStatus.merchantRequestId,
          },
        });
        if (result.count === 1) return true;
        const current = await tx.activationPaymentRequest.findUnique({
          where: { id: started.request!.id },
          select: { checkoutRequestId: true, merchantRequestId: true },
        });
        return current?.checkoutRequestId === providerStatus.checkoutRequestId &&
          current.merchantRequestId === providerStatus.merchantRequestId;
      });
      if (!bound) {
        return this.completeReconciliationAttempt(started.attempt.id, paymentId, superadminId, ipAddress, {
          outcome: 'UNRESOLVED_IDENTIFIER_MISMATCH',
          providerResultCode: String(providerStatus.resultCode),
          reasonCode: 'PROVIDER_IDENTIFIERS_CHANGED_DURING_REVIEW',
        });
      }
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return this.completeReconciliationAttempt(started.attempt.id, paymentId, superadminId, ipAddress, {
          outcome: 'UNRESOLVED_IDENTIFIER_MISMATCH',
          providerResultCode: String(providerStatus.resultCode),
          reasonCode: 'PROVIDER_IDENTIFIER_ALREADY_BOUND',
        });
      }
      await this.completeReconciliationAttempt(started.attempt.id, paymentId, superadminId, ipAddress, {
        outcome: 'QUERY_ERROR',
        providerResultCode: String(providerStatus.resultCode),
        reasonCode: 'PROVIDER_IDENTIFIERS_NOT_PERSISTED',
      });
      throw error;
    }

    if (providerStatus.resultCode === 4999) {
      return this.completeReconciliationAttempt(started.attempt.id, paymentId, superadminId, ipAddress, {
        outcome: 'UNRESOLVED_4999',
        providerResultCode: '4999',
        reasonCode: 'RESULT_4999_REMAINS_UNRESOLVED',
      });
    }
    if (providerStatus.resultCode === 0) {
      return this.completeReconciliationAttempt(started.attempt.id, paymentId, superadminId, ipAddress, {
        outcome: 'SUCCESS_AWAITING_VERIFIED_CALLBACK',
        providerResultCode: '0',
        reasonCode: 'QUERY_SUCCESS_CALLBACK_METADATA_REQUIRED',
      });
    }
    return this.completeReconciliationAttempt(started.attempt.id, paymentId, superadminId, ipAddress, {
      outcome: 'UNRESOLVED_UNKNOWN_RESULT',
      providerResultCode: String(providerStatus.resultCode),
      reasonCode: 'UNRECOGNIZED_PROVIDER_RESULT',
    });
  }

  async escalateActivationPayment(
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

    const findDuplicate = () => this.prisma.paymentReconciliationAttempt.findUnique({
      where: { paymentTransactionId_idempotencyKey: { paymentTransactionId: paymentId, idempotencyKey } },
      select: { id: true, outcome: true, providerResultCode: true, reasonCode: true, operatorNote: true, requestedAt: true, completedAt: true, superadminId: true },
    });
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.paymentReconciliationAttempt.findUnique({
          where: { paymentTransactionId_idempotencyKey: { paymentTransactionId: paymentId, idempotencyKey } },
          select: { id: true, outcome: true, providerResultCode: true, reasonCode: true, operatorNote: true, requestedAt: true, completedAt: true, superadminId: true },
        });
        if (existing) {
          if (existing.superadminId !== superadminId) {
            throw new ConflictException('This idempotency key belongs to another administrator.');
          }
          if (existing.outcome !== 'ESCALATED') {
            throw new ConflictException('This idempotency key was already used for a different reconciliation action.');
          }
          return existing;
        }

        const payment = await tx.paymentTransaction.findUnique({
          where: { id: paymentId },
          include: { activationRequest: true, loanApplication: true },
        });
        if (!payment) throw new NotFoundException('Payment was not found.');
        this.assertPaymentAssociation(payment, {
          paymentTransactionId: payment.id,
          userId: payment.activationRequest?.userId ?? '',
          loanApplicationId: payment.loanApplicationId,
        });
        const isLegacyUnresolved =
          payment.status === PaymentStatus.FAILED &&
          payment.failureCode === 'MPESA_RESULT_4999' &&
          payment.receiptReference === null;
        if (payment.status !== PaymentStatus.PENDING && !isLegacyUnresolved) {
          throw new ConflictException('Only unresolved activation or loan processing-fee payments can be escalated.');
        }

        const escalation = await tx.paymentReconciliationAttempt.create({
          data: {
            paymentTransactionId: paymentId,
            superadminId,
            idempotencyKey,
            operatorNote: sanitizedNote,
            outcome: 'ESCALATED',
            reasonCode: 'PROVIDER_INVESTIGATION_REQUIRED',
            completedAt: new Date(),
          },
          select: { id: true, outcome: true, providerResultCode: true, reasonCode: true, operatorNote: true, requestedAt: true, completedAt: true },
        });
        await tx.adminAuditLog.create({
          data: {
            superadminId,
            action: 'PAYMENT_RECONCILIATION_ESCALATED',
            subjectType: 'PAYMENT_TRANSACTION',
            subjectId: paymentId,
            outcome: 'ESCALATED',
            reason: sanitizedNote,
            ipAddress: ipAddress?.slice(0, 64),
          },
        });
        return escalation;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2002' || error.code === 'P2034')) {
        const duplicate = await findDuplicate();
        if (duplicate) {
          if (duplicate.superadminId !== superadminId) {
            throw new ConflictException('This idempotency key belongs to another administrator.');
          }
          if (duplicate.outcome !== 'ESCALATED') {
            throw new ConflictException('This idempotency key was already used for a different reconciliation action.');
          }
          return duplicate;
        }
        if (error.code === 'P2034') {
          throw new ConflictException('Another reconciliation request is being processed. Try again shortly.');
        }
      }
      throw error;
    }
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
            statusCheckMessage = 'The payment outcome is still being verified with Safaricom. Do not submit another payment while this request remains unresolved.';
          } else if (providerStatus.resultCode === 0) {
            statusCheckMessage = 'The payment outcome is still being verified with Safaricom. Do not submit another payment while this request remains unresolved.';
          } else if (this.getTerminalProviderStatus(providerStatus.resultCode) === null) {
            statusCheckMessage = 'Safaricom returned a result that does not conclusively resolve this payment. It remains pending; do not submit another payment.';
          } else {
            await this.settleActivationPayment(transaction, { ...request, loanApplicationId: null }, providerStatus);
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
          message: this.getCustomerPaymentMessage(
            effectiveStatus,
            providerResultCode,
            latestTransaction.failureCode,
          ),
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

  private getCustomerPaymentMessage(
    status: PaymentStatus,
    resultCode: number | null,
    failureCode: string | null = null,
  ): string {
    if (status === PaymentStatus.CONFIRMED) return 'Safaricom confirmed this payment.';
    if (status === PaymentStatus.PENDING) {
      return 'The payment outcome is still being verified with Safaricom. Do not submit another payment while this request remains unresolved.';
    }
    if (status === PaymentStatus.CANCELLED) return 'The M-Pesa payment was cancelled.';
    if (status === PaymentStatus.EXPIRED) return 'The M-Pesa payment expired without confirmation.';
    if (status === PaymentStatus.REVERSED) return 'This payment was reversed.';
    if (status === PaymentStatus.FAILED) {
      if (failureCode?.startsWith('MPESA_PREFLIGHT_')) {
        return 'Payment details failed local validation. No request was sent to Safaricom; review the amount and phone number before retrying.';
      }
      if (failureCode === 'MPESA_OAUTH_FAILED' || failureCode === 'MPESA_CONFIGURATION_FAILED') {
        return 'The request could not be sent to Safaricom, so no payment prompt was issued. Try again later or contact support.';
      }
      if (failureCode === 'MPESA_STK_REJECTED') {
        return 'Safaricom rejected the STK request before a payment could be confirmed. Review the payment details or contact support.';
      }
      return resultCode === null
        ? 'The payment could not be started or confirmed. Contact support before retrying.'
        : `Safaricom reported that this payment failed (result ${resultCode}).`;
    }
    return 'Payment confirmation has not been conclusively received. Do not submit another payment while this one is pending.';
  }

  async handleMpesaCallback(callbackToken: string, payload: unknown): Promise<{ ResultCode: number; ResultDesc: string }> {
    let callback: MpesaCallback;
    try {
      callback = this.parseCallback(payload);
    } catch (error) {
      this.logCallbackFailure(error, 'CALLBACK_PARSE');
      throw error;
    }
    const callbackTokenHash = hashToken(callbackToken);
    let request: Prisma.ActivationPaymentRequestGetPayload<{
      include: { paymentTransaction: true };
    }> | null;
    try {
      request = await this.prisma.activationPaymentRequest.findUnique({
        where: { callbackTokenHash },
        include: { paymentTransaction: true },
      });
    } catch (error) {
      this.logCallbackFailure(error, 'CALLBACK_TOKEN_LOOKUP');
      throw error;
    }
    if (!request) {
      const error = new NotFoundException('Payment callback is invalid.');
      this.logCallbackFailure(error, 'CALLBACK_TOKEN_LOOKUP');
      throw error;
    }
    logger.log(JSON.stringify({
      event: 'mpesa_callback_received',
      paymentId: request.paymentTransaction.id,
      applicationId: request.paymentTransaction.loanApplicationId,
      callbackResultCode: callback.ResultCode,
    }));
    let step = 'CALLBACK_VALIDATION';
    try {
      if (
        (request.checkoutRequestId !== null && callback.CheckoutRequestID !== request.checkoutRequestId) ||
        (request.merchantRequestId !== null && callback.MerchantRequestID !== request.merchantRequestId) ||
        (request.checkoutRequestId === null) !== (request.merchantRequestId === null)
      ) {
        throw new ForbiddenException('Payment callback did not match the requested transaction.');
      }
      this.assertPaymentAssociation(request.paymentTransaction, {
        ...request,
        loanApplicationId: request.paymentTransaction.loanApplicationId,
      });

      const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      step = 'CALLBACK_IDEMPOTENCY_CHECK';
      const priorEvent = await this.prisma.paymentCallbackEvent.findFirst({
        where: { activationPaymentRequestId: request.id, payloadHash },
        select: { id: true },
      });
      if (priorEvent && request.paymentTransaction.status === PaymentStatus.CONFIRMED) {
        return { ResultCode: 0, ResultDesc: 'Accepted' };
      }

      step = 'PROVIDER_STATUS_QUERY';
      const providerStatus = await this.mpesa.queryStkStatus(
        request.checkoutRequestId ?? callback.CheckoutRequestID,
      );
      step = 'PROVIDER_STATUS_VALIDATION';
      const checkoutRequestMatched = providerStatus.checkoutRequestId === callback.CheckoutRequestID;
      const merchantRequestMatched = providerStatus.merchantRequestId === callback.MerchantRequestID;
      const resultCodeMatched = providerStatus.resultCode === callback.ResultCode;
      logger.log(JSON.stringify({
        event: 'mpesa_provider_status_queried',
        paymentId: request.paymentTransaction.id,
        applicationId: request.paymentTransaction.loanApplicationId,
        resultCode: providerStatus.resultCode,
        checkoutRequestMatched,
        merchantRequestMatched,
        resultCodeMatched,
      }));
      if (
        !checkoutRequestMatched ||
        !merchantRequestMatched
      ) {
        throw new ServiceUnavailableException('M-Pesa callback could not be reconciled with provider status.');
      }
      if (!resultCodeMatched) {
        step = 'PENDING_CALLBACK_RECORDING';
        await this.recordUnresolvedCallback(
          {
            ...request,
            checkoutRequestId: providerStatus.checkoutRequestId,
            merchantRequestId: providerStatus.merchantRequestId,
          },
          providerStatus.resultCode,
          payloadHash,
          callback.ResultCode,
        );
        return { ResultCode: 0, ResultDesc: 'Accepted' };
      }
      step = 'PAYMENT_SETTLEMENT';
      await this.settleActivationPayment(
        request.paymentTransaction,
        {
          ...request,
          checkoutRequestId: providerStatus.checkoutRequestId,
          merchantRequestId: providerStatus.merchantRequestId,
          loanApplicationId: request.paymentTransaction.loanApplicationId,
        },
        providerStatus,
        callback,
        payloadHash,
      );
      if (providerStatus.resultCode === 0 && request.paymentTransaction.status === PaymentStatus.PENDING) {
        logger.log(JSON.stringify({
          event: 'mpesa_payment_settlement_committed',
          paymentId: request.paymentTransaction.id,
          applicationId: request.paymentTransaction.loanApplicationId,
          paymentType: request.paymentTransaction.type,
        }));
        if (request.paymentTransaction.type === PaymentType.LOAN_PROCESSING_FEE) {
          logger.log(JSON.stringify({
            event: 'mpesa_loan_application_submitted',
            paymentId: request.paymentTransaction.id,
            applicationId: request.paymentTransaction.loanApplicationId,
          }));
        }
      }
    } catch (error) {
      this.logCallbackFailure(error, step, request.paymentTransaction);
      throw error;
    }
    return { ResultCode: 0, ResultDesc: 'Accepted' };
  }

  private logCallbackFailure(
    error: unknown,
    step: string,
    payment?: { id: string; loanApplicationId: string | null },
  ): void {
    const errorCode = error instanceof Prisma.PrismaClientKnownRequestError
      ? error.code
      : error instanceof HttpException
        ? `HTTP_${error.getStatus()}`
        : 'UNEXPECTED';
    const verificationFailure = step === 'CALLBACK_PARSE' ||
      step === 'CALLBACK_VALIDATION' ||
      step === 'PROVIDER_STATUS_VALIDATION';
    logger.error(JSON.stringify({
      event: verificationFailure
        ? 'mpesa_callback_verification_failed'
        : step === 'PAYMENT_SETTLEMENT'
          ? 'mpesa_payment_settlement_failed'
          : 'mpesa_callback_processing_failed',
      paymentId: payment?.id ?? null,
      applicationId: payment?.loanApplicationId ?? null,
      step,
      errorType: error instanceof Error ? error.constructor.name : 'Unknown',
      errorCode,
    }));
  }

  private assertPaymentAssociation(
    payment: { id: string; userId: string; type: PaymentType; amountKes: number; currency: string },
    request: { paymentTransactionId: string; userId: string; loanApplicationId: string | null },
  ): void {
    const activationPayment = payment.type === PaymentType.ACTIVATION &&
      payment.amountKes === ACTIVATION_AMOUNT_KES &&
      request.loanApplicationId === null;
    const processingFee = payment.type === PaymentType.LOAN_PROCESSING_FEE &&
      payment.amountKes === LOAN_PROCESSING_FEE_KES &&
      typeof request.loanApplicationId === 'string';
    const walletDeposit = payment.type === PaymentType.WALLET_DEPOSIT &&
      Number.isSafeInteger(payment.amountKes) &&
      payment.amountKes > 0 &&
      request.loanApplicationId === null;
    if (payment.id !== request.paymentTransactionId || payment.userId !== request.userId ||
      payment.currency !== 'KES' || (!activationPayment && !processingFee && !walletDeposit)) {
      throw new ForbiddenException('Payment callback did not match a supported payment purpose and record.');
    }
  }

  private getTerminalProviderStatus(_resultCode: number): PaymentStatus | null {
    // No source-verified nonzero Daraja result-code mapping is configured yet.
    return null;
  }

  /**
  * Request acceptance, result 4999, unknown provider results, and temporary query errors remain unresolved.
   * Query-only success remains pending until a token-bound callback supplies verifiable success metadata.
   * Historical FAILED/MPESA_RESULT_4999 records remain unchanged pending an approved recovery procedure.
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
      failureCode: string | null;
      receiptReference: string | null;
    },
    request: {
      id: string;
      paymentTransactionId: string;
      userId: string;
      checkoutRequestId: string | null;
      merchantRequestId: string | null;
      loanApplicationId: string | null;
      phoneNumberCiphertext: string | null;
      policySnapshot: Prisma.JsonValue | null;
    },
    providerStatus: { checkoutRequestId: string; merchantRequestId: string; resultCode: number },
    callback?: MpesaCallback,
    payloadHash?: string,
    recovery?: { legacyVerifiedReceiptReference: string },
  ): Promise<void> {
    this.assertPaymentAssociation(payment, request);
    if (
      !request.checkoutRequestId ||
      !request.merchantRequestId ||
      providerStatus.checkoutRequestId !== request.checkoutRequestId ||
      providerStatus.merchantRequestId !== request.merchantRequestId
    ) {
      throw new ServiceUnavailableException('M-Pesa payment status did not match the stored request.');
    }
    const isLegacyUnresolved = payment.status === PaymentStatus.FAILED &&
      payment.failureCode === 'MPESA_RESULT_4999';
    const isLegacyProcessingFeeRecovery = isLegacyUnresolved &&
      payment.type === PaymentType.LOAN_PROCESSING_FEE &&
      payment.receiptReference === null &&
      recovery?.legacyVerifiedReceiptReference !== undefined &&
      /^[A-Za-z0-9]{6,32}$/.test(recovery.legacyVerifiedReceiptReference);
    if (isLegacyUnresolved && !isLegacyProcessingFeeRecovery) {
      if (payloadHash && callback) {
        const receiptReference = providerStatus.resultCode === 0
          ? this.validateSuccessfulCallback(callback, payment, request.phoneNumberCiphertext)
          : null;
        await this.prisma.paymentCallbackEvent.createMany({
          data: [{
            activationPaymentRequestId: request.id,
            paymentTransactionId: request.paymentTransactionId,
            payloadHash,
            providerResultCode: String(providerStatus.resultCode),
            providerReceiptReference: receiptReference,
          }],
          skipDuplicates: true,
        });
      }
      return;
    }
    if (isLegacyProcessingFeeRecovery && providerStatus.resultCode !== 0) {
      throw new ConflictException('A successful provider query is required to recover this payment.');
    }
    const isConfirmed = providerStatus.resultCode === 0;
    const targetStatus = isConfirmed
      ? PaymentStatus.CONFIRMED
      : this.getTerminalProviderStatus(providerStatus.resultCode);
    if (targetStatus === null) {
      if (payloadHash) {
        await this.recordUnresolvedCallback(request, providerStatus.resultCode, payloadHash, callback?.ResultCode);
      }
      return;
    }
    const isActivationPayment = payment.type === PaymentType.ACTIVATION;
    const isLoanProcessingFee = payment.type === PaymentType.LOAN_PROCESSING_FEE;
    const isWalletDeposit = payment.type === PaymentType.WALLET_DEPOSIT;
    let policy: ActivationPolicy | null = null;
    if (isConfirmed && isActivationPayment) {
      policy = this.parsePolicy(request.policySnapshot ?? undefined);
      if (!policy?.approved || /^draft(?:[-_. ]|$)/i.test(policy.termsVersion.trim())) {
        throw new ServiceUnavailableException('Activation accounting policy is unavailable.');
      }
    }
    if (isConfirmed && isWalletDeposit) {
      const depositPolicy = request.policySnapshot;
      if (!depositPolicy || typeof depositPolicy !== 'object' || Array.isArray(depositPolicy) ||
        depositPolicy.purpose !== 'WALLET_DEPOSIT' ||
        depositPolicy.amountKes !== payment.amountKes ||
        depositPolicy.currency !== 'KES') {
        throw new ServiceUnavailableException('Wallet deposit payment purpose is unavailable.');
      }
    }
    if (isConfirmed && !callback && !isLegacyProcessingFeeRecovery) {
      throw new ForbiddenException('A verified M-Pesa callback is required to confirm this payment.');
    }
    const receiptReference = isLegacyProcessingFeeRecovery
      ? recovery.legacyVerifiedReceiptReference
      : callback && isConfirmed
        ? this.validateSuccessfulCallback(callback, payment, request.phoneNumberCiphertext)
        : null;

    const now = new Date();
    try {
      await this.prisma.$transaction(async (tx) => {
        if (isLegacyProcessingFeeRecovery) {
          const verifiedEvent = await tx.paymentCallbackEvent.findFirst({
            where: {
              activationPaymentRequestId: request.id,
              paymentTransactionId: request.paymentTransactionId,
              providerResultCode: '0',
              providerReceiptReference: receiptReference,
            },
            select: { id: true },
          });
          if (!verifiedEvent) throw new ConflictException('Verified callback receipt evidence is unavailable.');
        }
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
          await tx.paymentCallbackEvent.upsert({
            where: {
              activationPaymentRequestId_payloadHash: {
                activationPaymentRequestId: request.id,
                payloadHash,
              },
            },
            create: {
              activationPaymentRequestId: request.id,
              paymentTransactionId: request.paymentTransactionId,
              payloadHash,
              providerResultCode: String(providerStatus.resultCode),
              providerReceiptReference: receiptReference,
            },
            update: {
              paymentTransactionId: request.paymentTransactionId,
              providerResultCode: String(providerStatus.resultCode),
              providerReceiptReference: receiptReference,
            },
          });
        }
        const changed = await tx.paymentTransaction.updateMany({
          where: {
            id: request.paymentTransactionId,
            ...(isLegacyProcessingFeeRecovery
              ? { status: PaymentStatus.FAILED, failureCode: 'MPESA_RESULT_4999', receiptReference: null }
              : { status: PaymentStatus.PENDING }),
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

        if (isConfirmed && isActivationPayment && policy) {
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
        if (isConfirmed && isLoanProcessingFee && request.loanApplicationId) {
          const application = await tx.loanApplication.findFirst({
            where: {
              id: request.loanApplicationId,
              userId: payment.userId,
              status: 'PROCESSING_PAYMENT_PENDING',
              processingFeePayments: { some: { id: payment.id, userId: payment.userId, type: PaymentType.LOAN_PROCESSING_FEE } },
            },
            select: { id: true },
          });
          if (!application) throw new ConflictException('Processing-fee payment is not associated with a payable application.');
          const revenueSetting = await tx.systemSetting.findUnique({
            where: { key: 'loan.processing_fee_revenue_account' },
            select: { value: true },
          });
          const revenueCode = typeof revenueSetting?.value === 'string' ? revenueSetting.value : null;
          const clearingAccount = await tx.ledgerAccount.findUnique({ where: { code: 'MPESA_CLEARING' } });
          const revenueAccount = revenueCode ? await tx.ledgerAccount.findUnique({ where: { code: revenueCode } }) : null;
          if (
            !clearingAccount?.isActive || clearingAccount.currency !== 'KES' || clearingAccount.accountType !== LedgerAccountType.ASSET ||
            !revenueAccount?.isActive || revenueAccount.currency !== 'KES' || revenueAccount.accountType !== LedgerAccountType.REVENUE
          ) {
            throw new ServiceUnavailableException('Loan processing-fee ledger accounts are unavailable.');
          }
          await this.ledger.postWithinTransaction(tx, {
            idempotencyKey: `loan-processing-fee:${payment.id}`,
            transactionType: 'LOAN_PROCESSING_FEE',
            actorType: 'PROVIDER',
            paymentId: payment.id,
            reason: 'Confirmed loan processing fee',
            lines: [
              { accountId: clearingAccount.id, debitKes: LOAN_PROCESSING_FEE_KES, creditKes: 0 },
              { accountId: revenueAccount.id, debitKes: 0, creditKes: LOAN_PROCESSING_FEE_KES },
            ],
          });
          const submitted = await tx.loanApplication.updateMany({
            where: {
              id: application.id,
              userId: payment.userId,
              status: 'PROCESSING_PAYMENT_PENDING',
            },
            data: { status: 'SUBMITTED', submittedAt: now },
          });
          if (submitted.count !== 1) throw new ConflictException('The loan application could not be submitted after payment.');
          await tx.authAuditLog.create({
            data: {
              actorType: 'PROVIDER',
              actorId: 'MPESA_DARAJA',
              action: 'LOAN_PROCESSING_FEE_CONFIRMED_AND_APPLICATION_SUBMITTED',
              outcome: 'SUCCESS',
            },
          });
        }
        if (isConfirmed && isWalletDeposit) {
          const walletAccount = await this.getOrCreateWalletAccount(tx, payment.userId);
          const clearingAccount = await tx.ledgerAccount.findUnique({ where: { code: 'MPESA_CLEARING' } });
          if (!clearingAccount?.isActive || clearingAccount.currency !== 'KES' ||
            clearingAccount.accountType !== LedgerAccountType.ASSET) {
            throw new ServiceUnavailableException('Wallet deposit clearing account is unavailable.');
          }
          await this.ledger.postWithinTransaction(tx, {
            idempotencyKey: `wallet-deposit:${payment.id}`,
            transactionType: 'WALLET_DEPOSIT',
            actorType: 'PROVIDER',
            paymentId: payment.id,
            reason: 'Verified M-Pesa wallet deposit',
            lines: [
              { accountId: clearingAccount.id, debitKes: payment.amountKes, creditKes: 0 },
              { accountId: walletAccount.id, debitKes: 0, creditKes: payment.amountKes },
            ],
          });
        }
        await tx.authAuditLog.create({
          data: {
            actorType: 'PROVIDER',
            actorId: 'MPESA_DARAJA',
            action: isActivationPayment
              ? 'ACTIVATION_PAYMENT_RECONCILIATION'
              : isWalletDeposit
                ? 'WALLET_DEPOSIT_RECONCILIATION'
                : 'LOAN_PROCESSING_FEE_RECONCILIATION',
            outcome: targetStatus,
          },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2002' || error.code === 'P2034') && payloadHash) {
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
    callbackResultCode?: number,
  ): Promise<void> {
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
        await tx.paymentCallbackEvent.createMany({
          data: [{
            activationPaymentRequestId: request.id,
            paymentTransactionId: request.paymentTransactionId,
            payloadHash,
            providerResultCode: String(callbackResultCode ?? resultCode),
            providerReceiptReference: null,
          }],
          skipDuplicates: true,
        });
        await tx.paymentTransaction.updateMany({
          where: { id: request.paymentTransactionId, status: PaymentStatus.PENDING },
          data: {
            failureCode: resultCode === 0 && callbackResultCode !== undefined
              ? 'CALLBACK_RESULT_MISMATCH'
              : `MPESA_RESULT_${resultCode}`,
          },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2002' || error.code === 'P2034')) {
        const persistedEvent = await this.prisma.paymentCallbackEvent.findFirst({
          where: { activationPaymentRequestId: request.id, payloadHash },
          select: { id: true },
        });
        if (persistedEvent) return;
      }
      throw error;
    }
  }

  private validateSuccessfulCallback(
    callback: MpesaCallback,
    payment: { type: PaymentType; amountKes: number; currency: string },
    phoneNumberCiphertext: string | null,
  ): string {
    const receipt = this.getCallbackItem(callback, 'MpesaReceiptNumber');
    const amount = this.getCallbackItem(callback, 'Amount');
    const phoneNumber = this.getCallbackItem(callback, 'PhoneNumber');
    const expectedAmount = payment.type === PaymentType.WALLET_DEPOSIT
      ? payment.amountKes
      : LOAN_PROCESSING_FEE_KES;
    if (
      payment.currency !== 'KES' ||
      payment.amountKes !== expectedAmount ||
      !Number.isSafeInteger(expectedAmount) ||
      expectedAmount <= 0 ||
      typeof amount !== 'number' ||
      !Number.isSafeInteger(amount) ||
      amount !== payment.amountKes ||
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
    return this.getOrCreateWalletAccount(tx, userId);
  }

  private async getOrCreateWalletAccount(tx: Prisma.TransactionClient, userId: string) {
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

  private async getWalletDepositConfiguration(): Promise<{
    limits: { minimumAmountKes: number; maximumAmountKes: number } | null;
    productApproved: boolean;
  }> {
    const setting = await this.prisma.systemSetting.findUnique({
      where: { key: WALLET_DEPOSIT_SETTING_KEY },
      select: { value: true },
    });
    const value = setting?.value;
    const record = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, Prisma.JsonValue>
      : {};
    const isValidAmount = (amount: Prisma.JsonValue | undefined): amount is number =>
      typeof amount === 'number' && Number.isSafeInteger(amount) &&
      amount > 0 && amount <= MAX_WALLET_DEPOSIT_AMOUNT_KES;
    const minimumAmountKes = isValidAmount(record.minimumAmountKes) ? record.minimumAmountKes : null;
    const maximumAmountKes = isValidAmount(record.maximumAmountKes) ? record.maximumAmountKes : null;
    const accountMappingReady =
      record.customerWalletLiabilityAccountCode === CUSTOMER_WALLET_LIABILITY_ACCOUNT_CODE &&
      record.mpesaClearingAccountCode === MPESA_CLEARING_ACCOUNT_CODE;
    const limits = minimumAmountKes !== null && maximumAmountKes !== null &&
      minimumAmountKes <= maximumAmountKes && accountMappingReady
      ? { minimumAmountKes, maximumAmountKes }
      : null;
    return {
      limits,
      productApproved: record.productApproved === true &&
        typeof record.approvalReference === 'string' &&
        record.approvalReference.trim().length > 0 &&
        accountMappingReady,
    };
  }

  private assertWalletDepositReplay(
    payment: {
      id: string;
      internalReference: string;
      userId: string;
      type: PaymentType;
      amountKes: number;
      currency: string;
      status: PaymentStatus;
      requestHash: string | null;
    },
    userId: string,
    requestHash: string,
  ) {
    if (payment.userId !== userId || payment.type !== PaymentType.WALLET_DEPOSIT ||
      payment.currency !== 'KES' || payment.requestHash !== requestHash) {
      throw new ConflictException('The idempotency key has already been used.');
    }
    return {
      reference: payment.internalReference,
      status: payment.status,
      amountKes: payment.amountKes,
      currency: payment.currency,
      message: payment.status === PaymentStatus.PENDING
        ? 'This wallet deposit remains unresolved. A new deposit is unavailable until its outcome is verified.'
        : payment.status === PaymentStatus.CONFIRMED
          ? 'This wallet deposit has already been confirmed.'
          : 'This wallet deposit attempt has already been recorded.',
    };
  }

}