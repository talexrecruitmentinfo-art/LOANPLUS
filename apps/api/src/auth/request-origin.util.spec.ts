import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { assertSameOrigin } from './request-origin.util';

describe('assertSameOrigin', () => {
  const originalWebOrigin = process.env.WEB_ORIGIN;

  afterEach(() => {
    if (originalWebOrigin === undefined) delete process.env.WEB_ORIGIN;
    else process.env.WEB_ORIGIN = originalWebOrigin;
  });

  it('accepts the configured frontend origin', () => {
    process.env.WEB_ORIGIN = 'https://loanplus.example';
    expect(() => assertSameOrigin({
      headers: { origin: 'https://loanplus.example' },
    } as Request)).not.toThrow();
  });

  it.each([undefined, 'https://attacker.example', 'not-an-origin'])('rejects missing or untrusted origins (%s)', (origin) => {
    process.env.WEB_ORIGIN = 'https://loanplus.example';
    expect(() => assertSameOrigin({
      headers: { origin },
    } as Request)).toThrow(ForbiddenException);
  });
});
