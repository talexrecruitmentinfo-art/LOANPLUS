import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { BadRequestException, InternalServerErrorException, Logger } from '@nestjs/common';

const logger = new Logger('AuthSecurity');

export interface AuthPrincipal {
  id: string;
  role: 'NORMAL_USER' | 'SUPERADMIN';
  email: string;
  phone?: string;
  fullName?: string;
  identityStatus?: string;
  referralCode?: string | null;
  sessionHash: string;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizeKenyaPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  let normalized: string;
  if (/^0[17]\d{8}$/.test(digits)) normalized = `254${digits.slice(1)}`;
  else if (/^254[17]\d{8}$/.test(digits)) normalized = digits;
  else throw new BadRequestException('Enter a valid Kenyan phone number.');
  return `+${normalized}`;
}

export function normalizeNationalId(nationalId: string): string {
  const normalized = nationalId.replace(/[\s-]/g, '');
  if (!/^\d{7,8}$/.test(normalized)) {
    throw new BadRequestException('Enter a valid National ID number.');
  }
  return normalized;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function keyedDigest(value: string, keyName: string): string {
  const key = process.env[keyName];
  if (!key || Buffer.byteLength(key) < 32) {
    logger.error(`Required security setting ${keyName} is missing or invalid.`);
    throw new InternalServerErrorException('A required security setting is unavailable.');
  }
  return createHmac('sha256', key).update(value).digest('hex');
}

function getNationalIdKey(): Buffer {
  const value = process.env.ID_ENCRYPTION_KEY_BASE64;
  if (!value) {
    logger.error('Required security setting ID_ENCRYPTION_KEY_BASE64 is missing.');
    throw new InternalServerErrorException('A required security setting is unavailable.');
  }
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
    logger.error('Required security setting ID_ENCRYPTION_KEY_BASE64 is invalid.');
    throw new InternalServerErrorException('A required security setting is unavailable.');
  }
  return key;
}

export function encryptSensitiveValue(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getNationalIdKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
}

export function encryptNationalId(nationalId: string): string {
  return encryptSensitiveValue(nationalId);
}

export function decryptNationalId(encrypted: string): string {
  return decryptSensitiveValue(encrypted);
}

export function decryptSensitiveValue(encrypted: string): string {
  const [version, ivPart, tagPart, ciphertextPart] = encrypted.split(':');
  if (version !== 'v1' || !ivPart || !tagPart || !ciphertextPart) {
    throw new InternalServerErrorException('Protected data could not be read.');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', getNationalIdKey(), Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new InternalServerErrorException('Protected data could not be read.');
  }
}

export function assertMatchingPasswords(password: string, confirmation: string): void {
  if (password !== confirmation) throw new BadRequestException('Passwords do not match.');
  if (Buffer.byteLength(password, 'utf8') > 72) {
    throw new BadRequestException('Password must be at most 72 bytes.');
  }
}