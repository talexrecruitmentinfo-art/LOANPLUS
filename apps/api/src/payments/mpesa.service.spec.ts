import { InternalServerErrorException, ServiceUnavailableException } from '@nestjs/common';
import { MpesaService } from './mpesa.service';

describe('M-Pesa Daraja HTTP integration', () => {
  const settingNames = [
    'MPESA_ENVIRONMENT',
    'MPESA_LIVE_ENABLED',
    'MPESA_CONSUMER_KEY',
    'MPESA_CONSUMER_SECRET',
    'MPESA_SHORT_CODE',
    'MPESA_TILL_NUMBER',
    'MPESA_PASSKEY',
    'MPESA_TRANSACTION_TYPE',
  ] as const;
  const originalSettings = Object.fromEntries(settingNames.map((name) => [name, process.env[name]]));
  let fetchMock: jest.SpyInstance;
  let mpesa: MpesaService;

  function mockJson(payload: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: jest.fn(async () => payload),
    } as unknown as Response;
  }

  beforeEach(() => {
    process.env.MPESA_ENVIRONMENT = 'sandbox';
    process.env.MPESA_LIVE_ENABLED = 'false';
    process.env.MPESA_CONSUMER_KEY = 'test-consumer-key';
    process.env.MPESA_CONSUMER_SECRET = 'test-consumer-secret';
    process.env.MPESA_SHORT_CODE = '174379';
    process.env.MPESA_PASSKEY = 'test-passkey-only';
    fetchMock = jest.spyOn(globalThis, 'fetch');
    mpesa = new MpesaService();
  });

  afterEach(() => {
    fetchMock.mockRestore();
    for (const name of settingNames) {
      const value = originalSettings[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('builds a Daraja sandbox STK request and parses both request IDs', async () => {
    fetchMock
      .mockResolvedValueOnce(mockJson({ access_token: 'test-access-token-123456', expires_in: '3599' }))
      .mockResolvedValueOnce(mockJson({
        ResponseCode: '0',
        CheckoutRequestID: 'ws_CO_test',
        MerchantRequestID: 'mr_test',
      }));

    const result = await mpesa.initiateStkPush({
      amountKes: 250,
      phoneNumber: '254712345678',
      accountReference: 'LPA123456789',
      description: 'Activation',
      callbackUrl: 'https://api.example.invalid/api/v1/payments/mpesa/callback/random-token',
    });

    expect(result).toEqual({ checkoutRequestId: 'ws_CO_test', merchantRequestId: 'mr_test' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [oauthUrl, oauthInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(oauthUrl).toBe('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials');
    expect(new Headers(oauthInit.headers).get('authorization')).toBe(
      `Basic ${Buffer.from('test-consumer-key:test-consumer-secret').toString('base64')}`,
    );
    const [stkUrl, stkInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(stkUrl).toBe('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest');
    const body = JSON.parse(String(stkInit.body)) as Record<string, string | number>;
    expect(body).toMatchObject({
      BusinessShortCode: '174379',
      TransactionType: 'CustomerPayBillOnline',
      Amount: 250,
      PartyA: '254712345678',
      PartyB: '174379',
      PhoneNumber: '254712345678',
      CallBackURL: 'https://api.example.invalid/api/v1/payments/mpesa/callback/random-token',
      AccountReference: 'LPA123456789',
      TransactionDesc: 'Activation',
    });
    expect(String(body.Timestamp)).toMatch(/^\d{14}$/);
    expect(Buffer.from(String(body.Password), 'base64').toString())
      .toBe(`174379test-passkey-only${body.Timestamp}`);
    expect(new Headers(stkInit.headers).get('authorization')).toBe('Bearer test-access-token-123456');
    expect(String(body.AccountReference)).toHaveLength(12);
    expect(String(body.TransactionDesc).length).toBeLessThanOrEqual(13);
  });

  it('uses the production Daraja endpoint only when live processing is explicitly enabled', async () => {
    process.env.MPESA_ENVIRONMENT = 'production';
    process.env.MPESA_LIVE_ENABLED = 'true';
    process.env.MPESA_TRANSACTION_TYPE = 'CustomerPayBillOnline';
    fetchMock.mockResolvedValueOnce(mockJson({ access_token: 'test-access-token-123456' }));
    fetchMock.mockResolvedValueOnce(mockJson({
      ResponseCode: '0',
      CheckoutRequestID: 'ws_CO_live',
      MerchantRequestID: 'mr_live',
    }));

    await mpesa.initiateStkPush({
      amountKes: 1,
      phoneNumber: '254112345678',
      accountReference: 'LPATEST12345',
      description: 'Activation',
      callbackUrl: 'https://api.example.invalid/callback/token',
    });
    expect(fetchMock.mock.calls[0][0])
      .toBe('https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials');
    expect(fetchMock.mock.calls[1][0])
      .toBe('https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest');
  });

  it('fails closed when live processing is not explicitly enabled', async () => {
    process.env.MPESA_ENVIRONMENT = 'production';
    process.env.MPESA_TRANSACTION_TYPE = 'CustomerPayBillOnline';
    expect(() => mpesa.assertConfiguredForPayments()).toThrow(ServiceUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports disabled production live payments in payment destination validation', () => {
    process.env.MPESA_ENVIRONMENT = 'production';
    process.env.MPESA_LIVE_ENABLED = 'false';
    process.env.MPESA_TRANSACTION_TYPE = 'CustomerPayBillOnline';
    expect(() => mpesa.getCustomerPaymentDestination()).toThrow('MPESA_LIVE_ENABLED=true');
  });

  it('loads MPESA_ENVIRONMENT=production at call time without requiring live payments to be enabled', () => {
    process.env.MPESA_ENVIRONMENT = 'production';
    process.env.MPESA_LIVE_ENABLED = 'false';
    process.env.MPESA_TRANSACTION_TYPE = 'CustomerBuyGoodsOnline';
    process.env.MPESA_SHORT_CODE = '5526990';
    process.env.MPESA_TILL_NUMBER = '3400188';

    expect(() => mpesa.getCustomerPaymentDestination()).toThrow(ServiceUnavailableException);
    expect(() => mpesa.getCustomerPaymentDestination()).toThrow('Production M-Pesa payments are disabled.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects invalid amount, phone, account reference, and transaction description before HTTP calls', async () => {
    const valid = {
      amountKes: 1,
      phoneNumber: '254712345678',
      accountReference: 'LPATEST12345',
      description: 'Activation',
      callbackUrl: 'https://api.example.invalid/callback/token',
    };
    for (const input of [
      { ...valid, amountKes: 0 },
      { ...valid, amountKes: 1.5 },
      { ...valid, phoneNumber: '+254712345678' },
      { ...valid, phoneNumber: '25471234567A' },
      { ...valid, phoneNumber: '25471234567' },
      { ...valid, accountReference: 'REFERENCE-TOO-LONG' },
      { ...valid, description: 'Description is too long' },
    ]) {
      await expect(mpesa.initiateStkPush(input)).rejects.toBeInstanceOf(ServiceUnavailableException);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects missing credential configuration without making HTTP requests', async () => {
    delete process.env.MPESA_CONSUMER_SECRET;
    expect(() => mpesa.assertConfiguredForPayments()).toThrow('MPESA_CONSUMER_SECRET');
    expect(() => mpesa.assertConfiguredForPayments()).toThrow(InternalServerErrorException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['MPESA_SHORT_CODE', 'Missing MPESA_SHORT_CODE'],
    ['MPESA_PASSKEY', 'Missing MPESA_PASSKEY'],
    ['MPESA_CONSUMER_KEY', 'Missing MPESA_CONSUMER_KEY'],
    ['MPESA_CONSUMER_SECRET', 'Missing MPESA_CONSUMER_SECRET'],
  ] as const)('returns an actionable configuration error when %s is missing', (name, _message) => {
    delete process.env[name];
    expect(() => mpesa.getCustomerPaymentDestination()).toThrow(name);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('handles OAuth rejection, missing tokens, provider rejection, and network timeouts safely', async () => {
    fetchMock.mockResolvedValueOnce(mockJson({ error: 'unauthorized' }, 401));
    const input = {
      amountKes: 1,
      phoneNumber: '254712345678',
      accountReference: 'LPATEST12345',
      description: 'Activation',
      callbackUrl: 'https://api.example.invalid/callback/token',
    };
    await expect(mpesa.initiateStkPush(input)).rejects.toBeInstanceOf(ServiceUnavailableException);

    fetchMock.mockResolvedValueOnce(mockJson({ access_token: 'short' }));
    await expect(mpesa.initiateStkPush(input)).rejects.toBeInstanceOf(ServiceUnavailableException);

    fetchMock
      .mockResolvedValueOnce(mockJson({ access_token: 'test-access-token-123456' }))
      .mockResolvedValueOnce(mockJson({ ResponseCode: '1', errorMessage: 'private provider detail' }));
    await expect(mpesa.initiateStkPush(input)).rejects.toBeInstanceOf(ServiceUnavailableException);

    fetchMock.mockRejectedValueOnce(new Error('test network timeout'));
    await expect(mpesa.queryStkStatus('ws_CO_test')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('requires an explicit environment instead of silently selecting sandbox', async () => {
    delete process.env.MPESA_ENVIRONMENT;
    expect(() => mpesa.assertConfiguredForPayments()).toThrow('MPESA_ENVIRONMENT');
    expect(() => mpesa.assertConfiguredForPayments()).toThrow(InternalServerErrorException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid configured transaction type as an actionable configuration error', async () => {
    process.env.MPESA_TRANSACTION_TYPE = 'C2B';
    expect(() => mpesa.assertConfiguredForPayments()).toThrow('MPESA_TRANSACTION_TYPE');
    expect(() => mpesa.assertConfiguredForPayments()).toThrow(InternalServerErrorException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires an explicit production transaction type matching the configured business account', () => {
    process.env.MPESA_ENVIRONMENT = 'production';
    process.env.MPESA_LIVE_ENABLED = 'true';
    delete process.env.MPESA_TRANSACTION_TYPE;
    expect(() => mpesa.assertConfiguredForPayments()).toThrow('MPESA_TRANSACTION_TYPE');
  });

  it('accepts fully configured production PayBill and Buy Goods destinations without making HTTP requests', () => {
    process.env.MPESA_ENVIRONMENT = 'production';
    process.env.MPESA_LIVE_ENABLED = 'true';
    process.env.MPESA_TRANSACTION_TYPE = 'CustomerPayBillOnline';
    expect(mpesa.getCustomerPaymentDestination()).toEqual({
      businessShortCode: '174379',
      tillNumber: null,
      transactionType: 'CustomerPayBillOnline',
    });

    process.env.MPESA_TRANSACTION_TYPE = 'CustomerBuyGoodsOnline';
    process.env.MPESA_SHORT_CODE = '5526990';
    process.env.MPESA_TILL_NUMBER = '3400188';
    expect(mpesa.getCustomerPaymentDestination()).toEqual({
      businessShortCode: '5526990',
      tillNumber: '3400188',
      transactionType: 'CustomerBuyGoodsOnline',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the confirmed production shortcode, Till, Buy Goods type, passkey, endpoints, and callback', async () => {
    process.env.MPESA_ENVIRONMENT = 'production';
    process.env.MPESA_LIVE_ENABLED = 'true';
    process.env.MPESA_TRANSACTION_TYPE = 'CustomerBuyGoodsOnline';
    process.env.MPESA_SHORT_CODE = '5526990';
    delete process.env.MPESA_TILL_NUMBER;

    expect(() => mpesa.getCustomerPaymentDestination()).toThrow('MPESA_TILL_NUMBER');
    expect(fetchMock).not.toHaveBeenCalled();

    process.env.MPESA_TILL_NUMBER = '3400188';
    fetchMock
      .mockResolvedValueOnce(mockJson({ access_token: 'test-access-token-123456' }))
      .mockResolvedValueOnce(mockJson({
        ResponseCode: '0',
        CheckoutRequestID: 'ws_CO_till',
        MerchantRequestID: 'mr_till',
      }));
    await mpesa.initiateStkPush({
      amountKes: 50,
      phoneNumber: '254712345678',
      accountReference: 'LPA123456789',
      description: 'Activation',
      callbackUrl: 'https://loanplus-api.onrender.com/api/v1/payments/mpesa/callback/token',
    });

    expect(fetchMock.mock.calls[0][0])
      .toBe('https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials');
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest');
    const body = JSON.parse(String(init.body)) as Record<string, string | number>;
    expect(body).toMatchObject({
      BusinessShortCode: '5526990',
      TransactionType: 'CustomerBuyGoodsOnline',
      PartyB: '3400188',
      CallBackURL: 'https://loanplus-api.onrender.com/api/v1/payments/mpesa/callback/token',
    });
    expect(Buffer.from(String(body.Password), 'base64').toString())
      .toBe(`5526990test-passkey-only${body.Timestamp}`);
  });

  it.each([
    ['MPESA_SHORT_CODE', 'not-numeric', 'MPESA_SHORT_CODE'],
    ['MPESA_TILL_NUMBER', '55-26990', 'MPESA_TILL_NUMBER'],
  ] as const)('rejects malformed production destination setting %s', (name, value, errorSetting) => {
    process.env.MPESA_ENVIRONMENT = 'production';
    process.env.MPESA_LIVE_ENABLED = 'true';
    process.env.MPESA_TRANSACTION_TYPE = 'CustomerBuyGoodsOnline';
    process.env.MPESA_SHORT_CODE = '123456';
    process.env.MPESA_SHORT_CODE = '5526990';
    process.env.MPESA_TILL_NUMBER = '3400188';
    process.env[name] = value;
    expect(() => mpesa.getCustomerPaymentDestination()).toThrow(errorSetting);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('queries the provider status using the configured shortcode and requires numeric result status', async () => {
    fetchMock
      .mockResolvedValueOnce(mockJson({ access_token: 'test-access-token-123456' }))
      .mockResolvedValueOnce(mockJson({
        ResponseCode: '0',
        CheckoutRequestID: 'ws_CO_test',
        MerchantRequestID: 'mr_test',
        ResultCode: '1032',
        ResultDesc: 'Cancelled',
      }));

    await expect(mpesa.queryStkStatus('ws_CO_test')).resolves.toEqual({
      checkoutRequestId: 'ws_CO_test',
      merchantRequestId: 'mr_test',
      resultCode: 1032,
      resultDescription: 'Cancelled',
    });
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://sandbox.safaricom.co.ke/mpesa/stkpushquery/v1/query');
    const body = JSON.parse(String(init.body)) as Record<string, string>;
    expect(body.CheckoutRequestID).toBe('ws_CO_test');
    expect(body.BusinessShortCode).toBe('174379');

    fetchMock
      .mockResolvedValueOnce(mockJson({ access_token: 'test-access-token-123456' }))
      .mockResolvedValueOnce(mockJson({
        ResponseCode: '0',
        CheckoutRequestID: 'ws_CO_test',
        MerchantRequestID: 'mr_test',
        ResultCode: 'invalid',
        ResultDesc: 'Invalid result',
      }));
    await expect(mpesa.queryStkStatus('ws_CO_test')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('queries production STK status with the configured BusinessShortCode, not the Till number', async () => {
    process.env.MPESA_ENVIRONMENT = 'production';
    process.env.MPESA_LIVE_ENABLED = 'true';
    process.env.MPESA_TRANSACTION_TYPE = 'CustomerBuyGoodsOnline';
    process.env.MPESA_SHORT_CODE = '5526990';
    process.env.MPESA_TILL_NUMBER = '3400188';
    fetchMock
      .mockResolvedValueOnce(mockJson({ access_token: 'test-access-token-123456' }))
      .mockResolvedValueOnce(mockJson({
        ResponseCode: '0',
        CheckoutRequestID: 'ws_CO_production',
        MerchantRequestID: 'mr_production',
        ResultCode: '0',
        ResultDesc: 'Confirmed',
      }));

    await expect(mpesa.queryStkStatus('ws_CO_production')).resolves.toMatchObject({
      checkoutRequestId: 'ws_CO_production',
      resultCode: 0,
    });
    expect(fetchMock.mock.calls[0][0])
      .toBe('https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials');
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://api.safaricom.co.ke/mpesa/stkpushquery/v1/query');
    expect(JSON.parse(String(init.body))).toMatchObject({
      BusinessShortCode: '5526990',
      CheckoutRequestID: 'ws_CO_production',
    });
  });

  it('allows status reconciliation when live STK initiation is disabled', async () => {
    process.env.MPESA_ENVIRONMENT = 'production';
    process.env.MPESA_LIVE_ENABLED = 'false';
    process.env.MPESA_TRANSACTION_TYPE = 'CustomerBuyGoodsOnline';
    process.env.MPESA_SHORT_CODE = '5526990';
    process.env.MPESA_TILL_NUMBER = '3400188';
    fetchMock
      .mockResolvedValueOnce(mockJson({ access_token: 'test-access-token-123456' }))
      .mockResolvedValueOnce(mockJson({
        ResponseCode: '0',
        CheckoutRequestID: 'ws_CO_reconcile',
        MerchantRequestID: 'mr_reconcile',
        ResultCode: '1032',
        ResultDesc: 'Cancelled',
      }));

    await expect(mpesa.queryStkStatus('ws_CO_reconcile')).resolves.toMatchObject({ resultCode: 1032 });
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.safaricom.co.ke/mpesa/stkpushquery/v1/query');
  });
});
