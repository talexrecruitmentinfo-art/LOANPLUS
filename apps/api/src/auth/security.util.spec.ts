import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  assertMatchingPasswords,
  createOpaqueToken,
  decryptNationalId,
  encryptNationalId,
  hashToken,
  normalizeEmail,
  normalizeKenyaPhone,
  normalizeNationalId,
} from './security.util';

describe('authentication security utilities', () => {
  beforeEach(() => {
    process.env.ID_ENCRYPTION_KEY_BASE64 = randomBytes(32).toString('base64');
  });

  it('normalizes email and Kenyan phone numbers', () => {
    expect(normalizeEmail('  Loan.User@Example.com ')).toBe('loan.user@example.com');
    expect(normalizeKenyaPhone('0712 345 678')).toBe('+254712345678');
    expect(normalizeKenyaPhone('0712-345-678')).toBe('+254712345678');
    expect(normalizeKenyaPhone('(0712) 345 678')).toBe('+254712345678');
    expect(normalizeKenyaPhone('+254712345678')).toBe('+254712345678');
    expect(normalizeKenyaPhone('+254112345678')).toBe('+254112345678');
    expect(normalizeKenyaPhone('0112345678')).toBe('+254112345678');
    expect(() => normalizeKenyaPhone('+712345678')).toThrow(BadRequestException);
    expect(() => normalizeKenyaPhone('+112345678')).toThrow(BadRequestException);
    expect(() => normalizeKenyaPhone('071234567')).toThrow(BadRequestException);
    expect(() => normalizeKenyaPhone('07123456789')).toThrow(BadRequestException);
    expect(() => normalizeKenyaPhone('12345')).toThrow(BadRequestException);
    expect(() => normalizeKenyaPhone('0712abc5678')).toThrow(BadRequestException);
  });

  it('normalizes National ID numbers without accepting malformed values', () => {
    expect(normalizeNationalId('12 34-5678')).toBe('12345678');
    expect(() => normalizeNationalId('123-ABC')).toThrow(BadRequestException);
    expect(() => normalizeNationalId('12345')).toThrow(BadRequestException);
  });

  it('encrypts National ID values with authenticated encryption', () => {
    const encrypted = encryptNationalId('12345678');
    expect(encrypted).not.toContain('12345678');
    expect(decryptNationalId(encrypted)).toBe('12345678');
    const [version, iv, tag, ciphertext] = encrypted.split(':');
    expect(() => decryptNationalId(`${version}:${iv}:${'A'.repeat(tag.length)}:${ciphertext}`)).toThrow(
      InternalServerErrorException,
    );
  });

  it('creates high-entropy opaque session tokens and stores only their digest', () => {
    const first = createOpaqueToken();
    const second = createOpaqueToken();
    expect(first).not.toBe(second);
    expect(first).not.toBe(hashToken(first));
    expect(hashToken(first)).toHaveLength(64);
  });

  it('requires matching passwords and rejects values beyond bcrypt byte limits', () => {
    expect(() => assertMatchingPasswords('a-secure-password', 'different-password')).toThrow(BadRequestException);
    expect(() => assertMatchingPasswords('é'.repeat(37), 'é'.repeat(37))).toThrow(BadRequestException);
    expect(() => assertMatchingPasswords('a-long-and-unique-password', 'a-long-and-unique-password')).not.toThrow();
  });
});