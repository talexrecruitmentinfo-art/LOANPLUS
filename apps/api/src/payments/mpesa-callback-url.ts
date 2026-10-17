import { InternalServerErrorException } from '@nestjs/common';
import { isIP } from 'node:net';

const CALLBACK_PATH = '/api/v1/payments/mpesa/callback';
const PRODUCTION_API_HOST = 'loanplus-api.onrender.com';

function isPublicHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal') ||
    normalized.endsWith('.invalid') ||
    normalized === 'vercel.app' ||
    normalized.endsWith('.vercel.app')
  ) return false;

  if (isIP(normalized) !== 0) return false;
  return normalized.includes('.') && !normalized.startsWith('.') && !normalized.endsWith('.');
}

export function buildMpesaCallbackUrl(callbackToken: string): string {
  const configuredUrl = process.env.MPESA_CALLBACK_URL;
  const requiredValue = `https://${PRODUCTION_API_HOST}${CALLBACK_PATH}`;
  if (!configuredUrl) {
    throw new InternalServerErrorException(
      `MPESA_CALLBACK_URL is required; set it to ${requiredValue} (without a payment token).`,
    );
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(configuredUrl);
  } catch {
    throw new InternalServerErrorException(
      `MPESA_CALLBACK_URL must be a valid HTTPS URL with the exact callback path ${CALLBACK_PATH}.`,
    );
  }

  const normalizedPath = baseUrl.pathname.replace(/\/+$/, '');
  let matchesFrontendOrigin = false;
  if (process.env.WEB_ORIGIN) {
    try {
      matchesFrontendOrigin = new URL(process.env.WEB_ORIGIN).hostname.toLowerCase() === baseUrl.hostname.toLowerCase();
    } catch {
      throw new InternalServerErrorException('WEB_ORIGIN must be a valid origin before M-Pesa callbacks can be configured.');
    }
  }
  const validCommonConfiguration = baseUrl.protocol === 'https:' &&
    !baseUrl.username &&
    !baseUrl.password &&
    !baseUrl.search &&
    !baseUrl.hash &&
    !baseUrl.port &&
    normalizedPath === CALLBACK_PATH &&
    !matchesFrontendOrigin &&
    isPublicHostname(baseUrl.hostname);
  if (!validCommonConfiguration) {
    throw new InternalServerErrorException(
      `MPESA_CALLBACK_URL must be a public HTTPS URL ending exactly in ${CALLBACK_PATH}, with no token, port, query, or fragment.`,
    );
  }

  if (process.env.NODE_ENV === 'production' && baseUrl.hostname.toLowerCase() !== PRODUCTION_API_HOST) {
    throw new InternalServerErrorException(
      `In production, set MPESA_CALLBACK_URL to ${requiredValue} (without a payment token).`,
    );
  }

  baseUrl.pathname = `${CALLBACK_PATH}/${callbackToken}`;
  return baseUrl.toString();
}
