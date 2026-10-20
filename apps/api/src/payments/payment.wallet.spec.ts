import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PaymentType } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service';
import type { LedgerService } from '../ledger/ledger.service';
import { MpesaService, StkPushInitiationError } from './mpesa.service';
import { WalletDepositDto } from './payment.dto';
import { PaymentService } from './payment.service';

describe('M-Pesa wallet deposit initiation', () => {
  const environment = {
    walletMin: process.env.WALLET_DEPOSIT_MIN_KES,
    walletMax: process.env.WALLET_DEPOSIT_MAX_KES,
    productApproved: process.env.WALLET_DEPOSIT_MPESA_PRODUCT_APPROVED,
    encryptionKey: process.env.ID_ENCRYPTION_KEY_BASE64,
    callbackUrl: process.env.MPESA_CALLBACK_URL,
  };
  let payment: Record<string, unknown> | null;
  let unresolvedPayment: Record<string, unknown> | null;
  let stkRequest: jest.Mock;
  let service: PaymentService;
  let activationRequestUpdate: jest.Mock;

  beforeEach(() => {
    process.env.WALLET_DEPOSIT_MIN_KES = '100';
    process.env.WALLET_DEPOSIT_MAX_KES = '20000';
    process.env.WALLET_DEPOSIT_MPESA_PRODUCT_APPROVED = 'true';
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
        findUnique: jest.fn(async () => ({
          id: 'mpesa-clearing-id',
          isActive: true,
          currency: 'KES',
          accountType: 'ASSET',
        })),
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
    if (environment.walletMin === undefined) delete process.env.WALLET_DEPOSIT_MIN_KES;
    else process.env.WALLET_DEPOSIT_MIN_KES = environment.walletMin;
    if (environment.walletMax === undefined) delete process.env.WALLET_DEPOSIT_MAX_KES;
    else process.env.WALLET_DEPOSIT_MAX_KES = environment.walletMax;
    if (environment.productApproved === undefined) delete process.env.WALLET_DEPOSIT_MPESA_PRODUCT_APPROVED;
    else process.env.WALLET_DEPOSIT_MPESA_PRODUCT_APPROVED = environment.productApproved;
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
