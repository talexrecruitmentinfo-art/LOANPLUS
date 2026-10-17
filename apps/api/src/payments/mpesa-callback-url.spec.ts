import { InternalServerErrorException } from '@nestjs/common';
import { buildMpesaCallbackUrl } from './mpesa-callback-url';

describe('buildMpesaCallbackUrl', () => {
  const originalEnvironment = {
    nodeEnv: process.env.NODE_ENV,
    callbackUrl: process.env.MPESA_CALLBACK_URL,
    webOrigin: process.env.WEB_ORIGIN,
  };

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    process.env.WEB_ORIGIN = 'https://loanplus-mnfs.vercel.app';
    process.env.MPESA_CALLBACK_URL = 'https://loanplus-api.onrender.com/api/v1/payments/mpesa/callback';
  });

  afterEach(() => {
    if (originalEnvironment.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnvironment.nodeEnv;
    if (originalEnvironment.callbackUrl === undefined) delete process.env.MPESA_CALLBACK_URL;
    else process.env.MPESA_CALLBACK_URL = originalEnvironment.callbackUrl;
    if (originalEnvironment.webOrigin === undefined) delete process.env.WEB_ORIGIN;
    else process.env.WEB_ORIGIN = originalEnvironment.webOrigin;
  });

  it('builds the deployed, versioned STK callback URL with the opaque payment token', () => {
    expect(buildMpesaCallbackUrl('opaque-callback-token')).toBe(
      'https://loanplus-api.onrender.com/api/v1/payments/mpesa/callback/opaque-callback-token',
    );
  });

  it('accepts a trailing slash on the configured base route and normalizes it', () => {
    process.env.MPESA_CALLBACK_URL = 'https://loanplus-api.onrender.com/api/v1/payments/mpesa/callback/';
    expect(buildMpesaCallbackUrl('opaque-token')).toBe(
      'https://loanplus-api.onrender.com/api/v1/payments/mpesa/callback/opaque-token',
    );
  });

  it.each([
    ['missing configuration', undefined],
    ['malformed URL', 'https://[invalid'],
    ['HTTP URL', 'http://loanplus-api.onrender.com/api/v1/payments/mpesa/callback'],
    ['localhost', 'https://localhost/api/v1/payments/mpesa/callback'],
    ['private IP address', 'https://10.0.0.2/api/v1/payments/mpesa/callback'],
    ['frontend origin', 'https://loanplus-mnfs.vercel.app/api/v1/payments/mpesa/callback'],
    ['wrong Render host', 'https://other-api.onrender.com/api/v1/payments/mpesa/callback'],
    ['wrong route', 'https://loanplus-api.onrender.com/api/v1/payments/mpesa/callback-v2'],
    ['preconfigured token', 'https://loanplus-api.onrender.com/api/v1/payments/mpesa/callback/token'],
    ['query string', 'https://loanplus-api.onrender.com/api/v1/payments/mpesa/callback?next=/'],
    ['fragment', 'https://loanplus-api.onrender.com/api/v1/payments/mpesa/callback#callback'],
    ['credentials', 'https://user:password@loanplus-api.onrender.com/api/v1/payments/mpesa/callback'],
    ['nonstandard port', 'https://loanplus-api.onrender.com:8443/api/v1/payments/mpesa/callback'],
  ])('rejects %s with an actionable server configuration error', (_label, configuredUrl) => {
    if (configuredUrl === undefined) delete process.env.MPESA_CALLBACK_URL;
    else process.env.MPESA_CALLBACK_URL = configuredUrl;
    expect(() => buildMpesaCallbackUrl('opaque-token')).toThrow(InternalServerErrorException);
  });

  it('names MPESA_CALLBACK_URL and the required Render value when it is missing', () => {
    delete process.env.MPESA_CALLBACK_URL;
    expect(() => buildMpesaCallbackUrl('opaque-token')).toThrow(
      'MPESA_CALLBACK_URL is required; set it to https://loanplus-api.onrender.com/api/v1/payments/mpesa/callback',
    );
  });

  it('returns an actionable error for an invalid callback URL in production', () => {
    process.env.MPESA_CALLBACK_URL = 'http://loanplus-api.onrender.com/api/v1/payments/mpesa/callback';
    expect(() => buildMpesaCallbackUrl('opaque-token')).toThrow(
      'MPESA_CALLBACK_URL must be a public HTTPS URL ending exactly in /api/v1/payments/mpesa/callback',
    );
  });

  it('allows an HTTPS public staging host when the runtime is not production', () => {
    process.env.NODE_ENV = 'staging';
    process.env.WEB_ORIGIN = 'https://loanplus-web-staging.onrender.com';
    process.env.MPESA_CALLBACK_URL = 'https://loanplus-staging.onrender.com/api/v1/payments/mpesa/callback';
    expect(buildMpesaCallbackUrl('opaque-token')).toBe(
      'https://loanplus-staging.onrender.com/api/v1/payments/mpesa/callback/opaque-token',
    );
  });

  it('rejects a staging callback on the configured frontend origin', () => {
    process.env.NODE_ENV = 'staging';
    process.env.WEB_ORIGIN = 'https://loanplus-web-staging.example.com';
    process.env.MPESA_CALLBACK_URL = 'https://loanplus-web-staging.example.com/api/v1/payments/mpesa/callback';
    expect(() => buildMpesaCallbackUrl('opaque-token')).toThrow(InternalServerErrorException);
  });
});
