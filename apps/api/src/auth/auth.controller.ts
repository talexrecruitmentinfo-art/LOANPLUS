import { Body, Controller, ForbiddenException, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { AuthService } from './auth.service';
import {
  CustomerLoginDto,
  PasswordChangeDto,
  PasswordResetCompleteDto,
  PasswordResetRequestDto,
  RegisterCustomerDto,
} from './auth.dto';
import { CustomerSessionGuard } from './session.guard';
import type { AuthenticatedRequest } from './request.types';

const CUSTOMER_COOKIE = 'lp_customer_session';
const CUSTOMER_SESSION_MS = 24 * 60 * 60 * 1000;

function assertSameOrigin(request: AuthenticatedRequest): void {
  const expected = new URL(process.env.WEB_ORIGIN ?? 'http://localhost:3000').origin;
  const requestOrigin = request.headers.origin;
  if (!requestOrigin) return;

  try {
    if (new URL(requestOrigin).origin !== expected) {
      throw new ForbiddenException('Request origin rejected.');
    }
  } catch {
    throw new ForbiddenException('Request origin rejected.');
  }
}

function setCustomerCookie(response: Response, token: string): void {
  response.cookie(CUSTOMER_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'strict',
    path: '/',
    maxAge: CUSTOMER_SESSION_MS,
  });
}

function clearCustomerCookie(response: Response): void {
  response.clearCookie(CUSTOMER_COOKIE, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'strict',
    path: '/',
  });
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async register(
    @Body() dto: RegisterCustomerDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    assertSameOrigin(request);
    const requestId = randomUUID();
    response.setHeader('X-Request-Id', requestId);
    const result = await this.auth.registerCustomer(dto, request.ip, requestId);
    setCustomerCookie(response, result.token);
    return { data: result.principal };
  }

  @Post('login')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async login(
    @Body() dto: CustomerLoginDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    assertSameOrigin(request);
    const result = await this.auth.loginCustomer(dto, request.ip);
    setCustomerCookie(response, result.token);
    return { data: result.principal };
  }

  @Get('me')
  @UseGuards(CustomerSessionGuard)
  getCurrentCustomer(@Req() request: AuthenticatedRequest) {
    const principal = request.principal!;
    return {
      data: {
        id: principal.id,
        role: principal.role,
        email: principal.email,
        fullName: principal.fullName,
        identityStatus: principal.identityStatus,
        activationStatus: principal.activationStatus,
        referralCode: principal.referralCode,
      },
    };
  }

  @Post('logout')
  @UseGuards(CustomerSessionGuard)
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    assertSameOrigin(request);
    await this.auth.logoutCustomer(request.principal!.sessionHash);
    clearCustomerCookie(response);
    return { data: { loggedOut: true } };
  }

  @Post('password/reset/request')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async requestPasswordReset(@Body() dto: PasswordResetRequestDto, @Req() request: AuthenticatedRequest) {
    assertSameOrigin(request);
    await this.auth.requestPasswordReset(dto);
    return { data: { message: 'If an eligible account exists, password reset instructions will be sent.' } };
  }

  @Post('password/reset/complete')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async completePasswordReset(@Body() dto: PasswordResetCompleteDto, @Req() request: AuthenticatedRequest) {
    assertSameOrigin(request);
    await this.auth.completePasswordReset(dto, request.ip);
    return { data: { passwordChanged: true } };
  }

  @Post('password/change')
  @UseGuards(CustomerSessionGuard)
  async changePassword(
    @Body() dto: PasswordChangeDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    assertSameOrigin(request);
    await this.auth.changeCustomerPassword(request.principal!.id, dto, request.ip);
    clearCustomerCookie(response);
    return { data: { passwordChanged: true, sessionsRevoked: true } };
  }
}