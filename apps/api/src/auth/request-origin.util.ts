import { ForbiddenException, InternalServerErrorException } from '@nestjs/common';
import type { Request } from 'express';

export function assertSameOrigin(request: Pick<Request, 'headers'>): void {
  const origin = request.headers.origin;
  if (!origin) throw new ForbiddenException('Request origin rejected.');

  const configuredOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
  let expected: string;
  let supplied: string;
  try {
    expected = new URL(configuredOrigin).origin;
  } catch {
    throw new InternalServerErrorException('WEB_ORIGIN must be a valid origin.');
  }
  try {
    supplied = new URL(origin).origin;
  } catch {
    throw new ForbiddenException('Request origin rejected.');
  }
  if (supplied !== expected) throw new ForbiddenException('Request origin rejected.');
}
