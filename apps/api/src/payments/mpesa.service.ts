import { Injectable, ServiceUnavailableException } from '@nestjs/common';

interface StkInitiationResult {
  checkoutRequestId: string;
  merchantRequestId: string;
}

export interface StkStatusResult {
  resultCode: number;
  resultDescription: string;
}

@Injectable()
export class MpesaService {
  assertConfiguredForPayments(): void {
    this.getConfiguration();
    this.requiredSetting('MPESA_CONSUMER_KEY');
    this.requiredSetting('MPESA_CONSUMER_SECRET');
  }

  async initiateStkPush(input: {
    amountKes: number;
    phoneNumber: string;
    accountReference: string;
    description: string;
    callbackUrl: string;
  }): Promise<StkInitiationResult> {
    const { apiBase, shortCode, passkey } = this.getConfiguration();
    if (!Number.isSafeInteger(input.amountKes) || input.amountKes <= 0) {
      throw new ServiceUnavailableException('M-Pesa payment initiation is unavailable.');
    }
    const accessToken = await this.getAccessToken(apiBase);
    const timestamp = this.formatTimestamp(new Date());
    const password = Buffer.from(`${shortCode}${passkey}${timestamp}`).toString('base64');
    const response = await this.requestJson(`${apiBase}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        BusinessShortCode: shortCode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: input.amountKes,
        PartyA: input.phoneNumber,
        PartyB: shortCode,
        PhoneNumber: input.phoneNumber,
        CallBackURL: input.callbackUrl,
        AccountReference: input.accountReference,
        TransactionDesc: input.description,
      }),
    });
    if (
      response.ResponseCode !== '0' ||
      typeof response.CheckoutRequestID !== 'string' ||
      typeof response.MerchantRequestID !== 'string'
    ) {
      throw new ServiceUnavailableException('M-Pesa did not accept the payment request.');
    }
    return {
      checkoutRequestId: response.CheckoutRequestID,
      merchantRequestId: response.MerchantRequestID,
    };
  }

  async queryStkStatus(checkoutRequestId: string): Promise<StkStatusResult> {
    const { apiBase, shortCode, passkey } = this.getConfiguration();
    const accessToken = await this.getAccessToken(apiBase);
    const timestamp = this.formatTimestamp(new Date());
    const password = Buffer.from(`${shortCode}${passkey}${timestamp}`).toString('base64');
    const response = await this.requestJson(`${apiBase}/mpesa/stkpushquery/v1/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        BusinessShortCode: shortCode,
        Password: password,
        Timestamp: timestamp,
        CheckoutRequestID: checkoutRequestId,
      }),
    });
    if (response.ResponseCode !== '0' || !/^\d+$/.test(String(response.ResultCode))) {
      throw new ServiceUnavailableException('M-Pesa could not confirm the payment status.');
    }
    return { resultCode: Number(response.ResultCode), resultDescription: String(response.ResultDesc ?? '') };
  }

  private async getAccessToken(apiBase: string): Promise<string> {
    const consumerKey = this.requiredSetting('MPESA_CONSUMER_KEY');
    const consumerSecret = this.requiredSetting('MPESA_CONSUMER_SECRET');
    const authorization = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    const response = await this.requestJson(`${apiBase}/oauth/v1/generate?grant_type=client_credentials`, {
      method: 'GET',
      headers: { Authorization: `Basic ${authorization}` },
    });
    if (typeof response.access_token !== 'string' || response.access_token.length < 16) {
      throw new ServiceUnavailableException('M-Pesa authentication is unavailable.');
    }
    return response.access_token;
  }

  private getConfiguration(): { apiBase: string; shortCode: string; passkey: string } {
    const environment = process.env.MPESA_ENVIRONMENT ?? 'sandbox';
    if (environment === 'production' && process.env.MPESA_LIVE_ENABLED !== 'true') {
      throw new ServiceUnavailableException('Live M-Pesa processing is disabled.');
    }
    if (environment !== 'sandbox' && environment !== 'production') {
      throw new ServiceUnavailableException('M-Pesa environment is not configured.');
    }
    return {
      apiBase: environment === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke',
      shortCode: this.requiredSetting('MPESA_SHORT_CODE'),
      passkey: this.requiredSetting('MPESA_PASSKEY'),
    };
  }

  private requiredSetting(name: string): string {
    const value = process.env[name];
    if (!value || value.startsWith('replace-with-')) {
      throw new ServiceUnavailableException('M-Pesa credentials are not configured.');
    }
    return value;
  }

  private async requestJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(12_000) });
    } catch {
      throw new ServiceUnavailableException('M-Pesa is temporarily unavailable.');
    }
    if (!response.ok) throw new ServiceUnavailableException('M-Pesa is temporarily unavailable.');
    const payload: unknown = await response.json().catch(() => null);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new ServiceUnavailableException('M-Pesa returned an invalid response.');
    }
    return payload as Record<string, unknown>;
  }

  private formatTimestamp(date: Date): string {
    const utc = new Date(date.getTime() + 3 * 60 * 60 * 1000);
    const parts = [utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate(), utc.getUTCHours(), utc.getUTCMinutes(), utc.getUTCSeconds()];
    return parts.map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0')).join('');
  }
}