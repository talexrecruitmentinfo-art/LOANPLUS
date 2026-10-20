import { HttpException, Injectable, InternalServerErrorException, ServiceUnavailableException } from '@nestjs/common';

interface StkInitiationResult {
  checkoutRequestId: string;
  merchantRequestId: string;
}

export class StkPushInitiationError extends ServiceUnavailableException {
  readonly providerDescription?: string;

  constructor(
    readonly phase: 'CONFIGURATION' | 'OAUTH' | 'STK_REQUEST' | 'STK_RESPONSE' | 'STK_REJECTED',
    readonly providerResponseCode?: string,
    readonly providerHttpStatus?: number,
    providerDescription?: string,
    readonly providerFailureStage?: 'HTTP' | 'TRANSPORT' | 'INVALID_RESPONSE',
  ) {
    super('M-Pesa payment initiation is unavailable.');
    this.providerDescription = providerDescription ? sanitizeProviderDescription(providerDescription) : undefined;
  }
}

class DarajaRequestError extends ServiceUnavailableException {
  constructor(
    readonly failureStage: 'HTTP' | 'TRANSPORT' | 'INVALID_RESPONSE',
    readonly providerHttpStatus: number | undefined,
    readonly providerResponseCode: string | undefined,
    readonly providerDescription: string | undefined,
  ) {
    super('M-Pesa is temporarily unavailable.');
  }
}

function sanitizeProviderDescription(candidate: string): string | undefined {
  const safe = candidate
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\b(access[\s_-]*token|consumer[\s_-]*secret|passkey|password|session[\s_-]*cookie)\b\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/\+?\d[\d ()-]{7,}\d/g, '[REDACTED]')
    .replace(/\b\d{7,}\b/g, '[REDACTED]')
    .replace(/[^\p{L}\p{N} .,;:!?='"()\[\]_-]/gu, ' ')
    .trim()
    .slice(0, 200);
  return safe || undefined;
}

export type StkPushPreflightReason =
  | 'INVALID_AMOUNT'
  | 'INVALID_PHONE'
  | 'INVALID_ACCOUNT_REFERENCE'
  | 'INVALID_DESCRIPTION';

export class StkPushPreflightError extends ServiceUnavailableException {
  constructor(readonly reasonCode: StkPushPreflightReason) {
    super('M-Pesa request failed local preflight validation.');
  }
}

export interface StkStatusResult {
  checkoutRequestId: string;
  merchantRequestId: string;
  resultCode: number;
  resultDescription: string;
}

export interface MpesaCustomerPaymentDestination {
  businessShortCode: string;
  tillNumber: string | null;
  transactionType: 'CustomerPayBillOnline' | 'CustomerBuyGoodsOnline';
}

@Injectable()
export class MpesaService {
  assertConfiguredForPayments(): void {
    this.getConfiguration();
    this.requiredSetting('MPESA_CONSUMER_KEY');
    this.requiredSetting('MPESA_CONSUMER_SECRET');
    this.assertLivePaymentsEnabled();
  }

  getCustomerPaymentDestination(): MpesaCustomerPaymentDestination {
    const { shortCode, tillNumber, transactionType } = this.getConfiguration();
    this.requiredSetting('MPESA_CONSUMER_KEY');
    this.requiredSetting('MPESA_CONSUMER_SECRET');
    this.assertLivePaymentsEnabled();
    return { businessShortCode: shortCode, tillNumber, transactionType };
  }

  async initiateStkPush(input: {
    amountKes: number;
    phoneNumber: string;
    accountReference: string;
    description: string;
    callbackUrl: string;
  }, beforeStkRequest?: () => Promise<void>): Promise<StkInitiationResult> {
    let configuration: ReturnType<MpesaService['getConfiguration']>;
    try {
      configuration = this.getConfiguration();
      this.requiredSetting('MPESA_CONSUMER_KEY');
      this.requiredSetting('MPESA_CONSUMER_SECRET');
      this.assertLivePaymentsEnabled();
    } catch (error) {
      if (error instanceof HttpException) throw new StkPushInitiationError('CONFIGURATION');
      throw error;
    }
    const { apiBase, shortCode, partyB, passkey, transactionType } = configuration;
    if (!Number.isSafeInteger(input.amountKes) || input.amountKes <= 0) {
      throw new StkPushPreflightError('INVALID_AMOUNT');
    }
    if (!/^254[17]\d{8}$/.test(input.phoneNumber)) {
      throw new StkPushPreflightError('INVALID_PHONE');
    }
    if (!/^[A-Za-z0-9]{1,12}$/.test(input.accountReference)) {
      throw new StkPushPreflightError('INVALID_ACCOUNT_REFERENCE');
    }
    if (!/^[A-Za-z0-9 ]{1,13}$/.test(input.description)) {
      throw new StkPushPreflightError('INVALID_DESCRIPTION');
    }
    let accessToken: string;
    try {
      accessToken = await this.getAccessToken(apiBase);
    } catch (error) {
      throw this.toInitiationError('OAUTH', error);
    }
    const timestamp = this.formatTimestamp(new Date());
    const password = Buffer.from(`${shortCode}${passkey}${timestamp}`).toString('base64');
    await beforeStkRequest?.();
    let response: Record<string, unknown>;
    let providerHttpStatus: number;
    try {
      const result = await this.requestJson(`${apiBase}/mpesa/stkpush/v1/processrequest`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          BusinessShortCode: shortCode,
          Password: password,
          Timestamp: timestamp,
          TransactionType: transactionType,
          Amount: input.amountKes,
          PartyA: input.phoneNumber,
          PartyB: partyB,
          PhoneNumber: input.phoneNumber,
          CallBackURL: input.callbackUrl,
          AccountReference: input.accountReference,
          TransactionDesc: input.description,
        }),
      });
      response = result.payload;
      providerHttpStatus = result.httpStatus;
    } catch (error) {
      throw this.toInitiationError('STK_REQUEST', error);
    }
    const responseCode = this.getProviderResponseCode(response.ResponseCode);
    const responseDescription = this.getProviderDescription(response);
    if (responseCode !== undefined && /^\d{1,12}$/.test(responseCode) && responseCode !== '0') {
      throw new StkPushInitiationError('STK_REJECTED', responseCode, providerHttpStatus, responseDescription);
    }
    if (
      responseCode !== '0' ||
      typeof response.CheckoutRequestID !== 'string' ||
      response.CheckoutRequestID.length === 0 ||
      response.CheckoutRequestID.length > 100 ||
      typeof response.MerchantRequestID !== 'string' ||
      response.MerchantRequestID.length === 0 ||
      response.MerchantRequestID.length > 100
    ) {
      throw new StkPushInitiationError('STK_RESPONSE', responseCode, providerHttpStatus, responseDescription);
    }
    return {
      checkoutRequestId: response.CheckoutRequestID,
      merchantRequestId: response.MerchantRequestID,
    };
  }

  async queryStkStatus(checkoutRequestId: string): Promise<StkStatusResult> {
    const { apiBase, shortCode, passkey } = this.getConfiguration();
    this.requiredSetting('MPESA_CONSUMER_KEY');
    this.requiredSetting('MPESA_CONSUMER_SECRET');
    const accessToken = await this.getAccessToken(apiBase);
    const timestamp = this.formatTimestamp(new Date());
    const password = Buffer.from(`${shortCode}${passkey}${timestamp}`).toString('base64');
    const { payload: response } = await this.requestJson(`${apiBase}/mpesa/stkpushquery/v1/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        BusinessShortCode: shortCode,
        Password: password,
        Timestamp: timestamp,
        CheckoutRequestID: checkoutRequestId,
      }),
    });
    const resultCode = Number(response.ResultCode);
    if (
      response.ResponseCode !== '0' ||
      typeof response.CheckoutRequestID !== 'string' ||
      response.CheckoutRequestID.length === 0 ||
      response.CheckoutRequestID.length > 100 ||
      typeof response.MerchantRequestID !== 'string' ||
      response.MerchantRequestID.length === 0 ||
      response.MerchantRequestID.length > 100 ||
      !/^\d+$/.test(String(response.ResultCode)) ||
      !Number.isSafeInteger(resultCode) ||
      typeof response.ResultDesc !== 'string'
    ) {
      throw new ServiceUnavailableException('M-Pesa could not confirm the payment status.');
    }
    return {
      checkoutRequestId: response.CheckoutRequestID,
      merchantRequestId: response.MerchantRequestID,
      resultCode,
      resultDescription: response.ResultDesc,
    };
  }

  private async getAccessToken(apiBase: string): Promise<string> {
    const consumerKey = this.requiredSetting('MPESA_CONSUMER_KEY');
    const consumerSecret = this.requiredSetting('MPESA_CONSUMER_SECRET');
    const authorization = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    const { payload: response, httpStatus } = await this.requestJson(`${apiBase}/oauth/v1/generate?grant_type=client_credentials`, {
      method: 'GET',
      headers: { Authorization: `Basic ${authorization}` },
    });
    if (typeof response.access_token !== 'string' || response.access_token.length < 16) {
      throw new DarajaRequestError(
        'INVALID_RESPONSE',
        httpStatus,
        this.getProviderResponseCode(response.ResponseCode ?? response.errorCode),
        this.getProviderDescription(response),
      );
    }
    return response.access_token;
  }

  private getConfiguration(): {
    apiBase: string;
    shortCode: string;
    partyB: string;
    tillNumber: string | null;
    passkey: string;
    transactionType: 'CustomerPayBillOnline' | 'CustomerBuyGoodsOnline';
  } {
    const environment = process.env.MPESA_ENVIRONMENT;
    if (!environment) {
      throw new InternalServerErrorException('MPESA_ENVIRONMENT must be set to sandbox or production.');
    }
    if (environment !== 'sandbox' && environment !== 'production') {
      throw new InternalServerErrorException('MPESA_ENVIRONMENT must be set to sandbox or production.');
    }
    const transactionType = process.env.MPESA_TRANSACTION_TYPE ??
      (environment === 'sandbox' ? 'CustomerPayBillOnline' : undefined);
    if (!transactionType) {
      throw new InternalServerErrorException(
        'MPESA_TRANSACTION_TYPE must explicitly match the production Safaricom business account.',
      );
    }
    if (transactionType !== 'CustomerPayBillOnline' && transactionType !== 'CustomerBuyGoodsOnline') {
      throw new InternalServerErrorException(
        'MPESA_TRANSACTION_TYPE must be CustomerPayBillOnline or CustomerBuyGoodsOnline and match the Safaricom business account.',
      );
    }
    const shortCode = this.requiredSetting('MPESA_SHORT_CODE');
    if (!/^\d{1,20}$/.test(shortCode)) {
      throw new InternalServerErrorException('MPESA_SHORT_CODE must contain only digits.');
    }
    const tillNumber = transactionType === 'CustomerBuyGoodsOnline'
      ? this.requiredSetting('MPESA_TILL_NUMBER')
      : null;
    if (tillNumber !== null && !/^\d{1,20}$/.test(tillNumber)) {
      throw new InternalServerErrorException('MPESA_TILL_NUMBER must contain only digits.');
    }
    return {
      apiBase: environment === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke',
      shortCode,
      partyB: tillNumber ?? shortCode,
      tillNumber,
      passkey: this.requiredSetting('MPESA_PASSKEY'),
      transactionType,
    };
  }

  private assertLivePaymentsEnabled(): void {
    if (process.env.MPESA_ENVIRONMENT === 'production' && process.env.MPESA_LIVE_ENABLED !== 'true') {
      throw new ServiceUnavailableException(
        'Production M-Pesa payments are disabled. Set MPESA_LIVE_ENABLED=true only after production configuration and deployment verification.',
      );
    }
  }

  private requiredSetting(name: string): string {
    const value = process.env[name];
    if (!value || value.startsWith('replace-with-')) {
      throw new InternalServerErrorException(`${name} must be configured in the API environment.`);
    }
    return value;
  }

  private async requestJson(
    url: string,
    init: RequestInit,
  ): Promise<{ payload: Record<string, unknown>; httpStatus: number }> {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(12_000) });
    } catch {
      throw new DarajaRequestError('TRANSPORT', undefined, undefined, undefined);
    }
    const payload: unknown = await response.json().catch(() => null);
    const providerPayload = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : null;
    if (!response.ok) {
      throw new DarajaRequestError(
        'HTTP',
        response.status,
        providerPayload
          ? this.getProviderResponseCode(providerPayload.ResponseCode ?? providerPayload.errorCode ?? providerPayload.error)
          : undefined,
        providerPayload ? this.getProviderDescription(providerPayload) : undefined,
      );
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new DarajaRequestError('INVALID_RESPONSE', response.status, undefined, undefined);
    }
    return { payload: payload as Record<string, unknown>, httpStatus: response.status };
  }

  private toInitiationError(
    phase: 'OAUTH' | 'STK_REQUEST',
    error: unknown,
  ): StkPushInitiationError {
    if (error instanceof DarajaRequestError) {
      return new StkPushInitiationError(
        phase,
        error.providerResponseCode,
        error.providerHttpStatus,
        error.providerDescription,
        error.failureStage,
      );
    }
    return new StkPushInitiationError(phase);
  }

  private getProviderResponseCode(value: unknown): string | undefined {
    const candidate = typeof value === 'string'
      ? value
      : typeof value === 'number' && Number.isSafeInteger(value)
        ? String(value)
        : undefined;
    if (!candidate) return undefined;
    return /^\d{1,6}$/.test(candidate) || /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/.test(candidate)
      ? candidate
      : undefined;
  }

  private getProviderDescription(payload: Record<string, unknown>): string | undefined {
    const candidate = [
      payload.ResponseDescription,
      payload.errorMessage,
      payload.error_description,
      payload.message,
    ].find((value): value is string => typeof value === 'string');
    if (!candidate) return undefined;
    return sanitizeProviderDescription(candidate);
  }

  private formatTimestamp(date: Date): string {
    const utc = new Date(date.getTime() + 3 * 60 * 60 * 1000);
    const parts = [utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate(), utc.getUTCHours(), utc.getUTCMinutes(), utc.getUTCSeconds()];
    return parts.map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0')).join('');
  }
}