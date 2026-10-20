import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PaymentType } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service';
import type { LedgerService } from '../ledger/ledger.service';
import { MpesaService, StkPushInitiationError } from './mpesa.service';
import { WalletDepositDto } from './payment.dto';
import { PaymentService } from './payment.service';
import {
  CUSTOMER_WALLET_LIABILITY_ACCOUNT_CODE,
  MPESA_CLEARING_ACCOUNT_CODE,
  WALLET_DEPOSIT_SETTING_KEY,
} from './wallet-deposit.config';

describe('M-Pesa wallet deposit initiation', () => {
  const environment = {
    encryptionKey: process.env.ID_ENCRYPTION_KEY_BASE64,
    callbackUrl: process.env.MPESA_CALLBACK_URL,
  };
  let payment: Record<string, unknown> | null;
  let unresolvedPayment: Record<string, unknown> | null;
  let stkRequest: jest.Mock;
  let service: PaymentService;
  let activationRequestUpdate: jest.Mock;

  beforeEach(() => {
    process.env.ID_ENCRYPTION_KEY_BASE64 = randomBytes(32).toString('base64');
    process.env.MPESA_CALLBACK_URL = 'https://api.example.test/api/v1/payments/mpesa/callback';
    payment = null;
    unresolvedPayment = null;
    activationRequestUpdate = jest.fn(async () => ({ count: 1 }));
    stkRequest = jest.fn(async () => ({
      checkoutRequestId: 'checkout-test',
      merchantRequestId: 'merchant-test',
    }));
    const transactionClient = {
      paymentTransaction: {
        findUnique: jest.fn(async () => null),
        findFirst: jest.fn(async () => unresolvedPayment),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          payment = {
            id: 'wallet-payment-id',
            internalReference: 'LPD000000000000000000000000000001',
            userId: 'customer-id',
            status: 'PENDING',
            ...data,
          };
          return { id: payment.id, internalReference: payment.internalReference };
        }),
        updateMany: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          if (payment) payment = { ...payment, ...data };
          return { count: 1 };
        }),
      },
      activationPaymentRequest: { updateMany: activationRequestUpdate },
    };
    const prisma = {
      paymentTransaction: {
        findUnique: jest.fn(async () => null),
        findFirst: jest.fn(async () => unresolvedPayment),
        updateMany: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          if (payment) payment = { ...payment, ...data };
          return { count: 1 };
        }),
      },
      user: { findUnique: jest.fn(async () => ({ isActive: true })) },
      ledgerAccount: {
        findUnique: jest.fn(async ({ where }: { where: { code: string } }) => ({
          id: where.code,
          isActive: true,
          currency: 'KES',
          accountType: where.code === MPESA_CLEARING_ACCOUNT_CODE ? 'ASSET' : 'LIABILITY',
        })),
      },
      systemSetting: {
        findUnique: jest.fn(async ({ where }: { where: { key: string } }) => where.key === WALLET_DEPOSIT_SETTING_KEY
          ? { value: {
            minimumAmountKes: 100,
            maximumAmountKes: 20000,
            productApproved: true,
            approvalReference: 'TEST-APPROVAL-REFERENCE',
            customerWalletLiabilityAccountCode: CUSTOMER_WALLET_LIABILITY_ACCOUNT_CODE,
            mpesaClearingAccountCode: MPESA_CLEARING_ACCOUNT_CODE,
          } }
          : null),
      },
      $transaction: jest.fn(async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
        callback(transactionClient)),
    } as unknown as PrismaService;
    const mpesa = {
      assertConfiguredForPayments: jest.fn(),
      initiateStkPush: stkRequest,
    } as unknown as MpesaService;
    service = new PaymentService(prisma, mpesa, {} as LedgerService);
  });

  afterEach(() => {
    if (environment.encryptionKey === undefined) delete process.env.ID_ENCRYPTION_KEY_BASE64;
    else process.env.ID_ENCRYPTION_KEY_BASE64 = environment.encryptionKey;
    if (environment.callbackUrl === undefined) delete process.env.MPESA_CALLBACK_URL;
    else process.env.MPESA_CALLBACK_URL = environment.callbackUrl;
  });

  const depositRequest = () => Object.assign(new WalletDepositDto(), {
    amountKes: 500,
    mpesaPhoneNumber: '+254712345678',
  });

  it('persists a distinct wallet deposit before issuing one STK request', async () => {
    const result = await service.initiateWalletDeposit('customer-id', depositRequest(), 'wallet-deposit-key-001');

    expect(result).toMatchObject({ status: 'PENDING', amountKes: 500, currency: 'KES' });
    expect(payment).toMatchObject({
      type: PaymentType.WALLET_DEPOSIT,
      amountKes: 500,
      currency: 'KES',
      status: 'PENDING',
      initiationPhase: 'PROVIDER_ACCEPTED',
    });
    expect(stkRequest).toHaveBeenCalledTimes(1);
    expect(stkRequest).toHaveBeenCalledWith(expect.objectContaining({
      amountKes: 500,
      phoneNumber: '254712345678',
      accountReference: (payment?.internalReference as string).slice(-12),
      description: 'Wallet deposit',
      callbackUrl: expect.stringMatching(/^https:\/\/api\.example\.test\/api\/v1\/payments\/mpesa\/callback\//),
    }), expect.any(Function));
    expect(activationRequestUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: { checkoutRequestId: 'checkout-test', merchantRequestId: 'merchant-test' },
    }));
  });

  it.each([0, 99, 20001, 10.5])('rejects invalid wallet deposit amount %s before M-Pesa initiation', async (amountKes) => {
    await expect(service.initiateWalletDeposit('customer-id', {
      ...depositRequest(),
      amountKes,
    }, 'wallet-deposit-key-invalid')).rejects.toBeInstanceOf(BadRequestException);
    expect(stkRequest).not.toHaveBeenCalled();
  });

  it('rejects a customer without an active account before M-Pesa initiation', async () => {
    const inactivePrisma = {
      paymentTransaction: { findUnique: jest.fn(async () => null) },
      user: { findUnique: jest.fn(async () => ({ isActive: false })) },
      ledgerAccount: { findUnique: jest.fn(async () => ({ isActive: true, currency: 'KES', accountType: 'ASSET' })) },
      systemSetting: {
        findUnique: jest.fn(async () => ({ value: {
          minimumAmountKes: 100,
          maximumAmountKes: 20000,
          productApproved: true,
          approvalReference: 'TEST-APPROVAL-REFERENCE',
          customerWalletLiabilityAccountCode: CUSTOMER_WALLET_LIABILITY_ACCOUNT_CODE,
          mpesaClearingAccountCode: MPESA_CLEARING_ACCOUNT_CODE,
        } })),
      },
    } as unknown as PrismaService;
    const inactiveService = new PaymentService(
      inactivePrisma,
      { assertConfiguredForPayments: jest.fn(), initiateStkPush: stkRequest } as unknown as MpesaService,
      {} as LedgerService,
    );
    await expect(inactiveService.initiateWalletDeposit('customer-id', depositRequest(), 'wallet-deposit-key-inactive'))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(stkRequest).not.toHaveBeenCalled();
  });

  it.each([100, 20000])('allows an authorized boundary amount of %s KES', async (amountKes) => {
    await service.initiateWalletDeposit('customer-id', {
      ...depositRequest(),
      amountKes,
    }, `wallet-deposit-boundary-${amountKes}`);
    expect(stkRequest).toHaveBeenCalledTimes(1);
    expect(stkRequest).toHaveBeenCalledWith(expect.objectContaining({ amountKes }), expect.any(Function));
  });

  it.each([
    [99, 'outside the configured wallet limits'],
    [20001, 'outside the configured wallet limits'],
    [2_147_483_648, 'positive whole-KSh'],
  ])('rejects amount-specific quotes outside approved limits (%s KES)', async (amountKes, message) => {
    await expect(service.getWalletDepositQuote(amountKes)).rejects.toThrow(
      message,
    );
  });

  it('accepts an amount-specific quote at both approved boundaries', async () => {
    await expect(service.getWalletDepositQuote(100)).resolves.toMatchObject({
      currency: 'KES',
      minimumAmountKes: 100,
      maximumAmountKes: 20000,
      depositAvailable: true,
    });
    await expect(service.getWalletDepositQuote(20000)).resolves.toMatchObject({
      depositAvailable: true,
    });
  });

  it('rejects initiation when saved limits or production approval are absent', async () => {
    const configurationMissing = new PaymentService({
      systemSetting: { findUnique: jest.fn(async () => null) },
    } as unknown as PrismaService, {} as MpesaService, {} as LedgerService);
    await expect(configurationMissing.initiateWalletDeposit(
      'customer-id',
      depositRequest(),
      'wallet-deposit-missing-config',
    )).rejects.toThrow('Approved wallet-deposit amount limits are not configured.');

    const approvalMissing = new PaymentService({
      systemSetting: { findUnique: jest.fn(async () => ({ value: {
        minimumAmountKes: 100,
        maximumAmountKes: 20000,
        productApproved: false,
        customerWalletLiabilityAccountCode: CUSTOMER_WALLET_LIABILITY_ACCOUNT_CODE,
        mpesaClearingAccountCode: MPESA_CLEARING_ACCOUNT_CODE,
      } })) },
    } as unknown as PrismaService, {} as MpesaService, {} as LedgerService);
    await expect(approvalMissing.initiateWalletDeposit(
      'customer-id',
      depositRequest(),
      'wallet-deposit-unapproved-product',
    )).rejects.toThrow('confirmed for customer wallet deposits');
    expect(stkRequest).not.toHaveBeenCalled();
  });

  it('does not issue another STK request while a previous deposit remains unresolved', async () => {
    unresolvedPayment = {
      internalReference: 'LPD000000000000000000000000000009',
      amountKes: 900,
      currency: 'KES',
      status: 'PENDING',
    };
    const result = await service.initiateWalletDeposit('customer-id', depositRequest(), 'wallet-deposit-key-002');
    expect(result).toMatchObject({ reference: unresolvedPayment.internalReference, status: 'PENDING' });
    expect(stkRequest).not.toHaveBeenCalled();
  });

  it('keeps uncertain STK outcomes pending and blocks a replacement request', async () => {
    stkRequest.mockRejectedValueOnce(new StkPushInitiationError('STK_REQUEST'));
    const result = await service.initiateWalletDeposit('customer-id', depositRequest(), 'wallet-deposit-key-003');
    expect(result).toMatchObject({ status: 'PENDING' });
    expect(payment).toMatchObject({
      status: 'PENDING',
      failureCode: 'INITIATION_OUTCOME_UNCERTAIN',
      initiationPhase: 'STK_REQUEST_OUTCOME_UNCERTAIN',
    });
    unresolvedPayment = payment;
    const retry = await service.initiateWalletDeposit('customer-id', depositRequest(), 'wallet-deposit-key-004');
    expect(retry).toMatchObject({ status: 'PENDING' });
    expect(stkRequest).toHaveBeenCalledTimes(1);
  });
});
