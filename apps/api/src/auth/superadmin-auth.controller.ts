import { Body, Controller, ForbiddenException, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { AuthService } from './auth.service';
import { SuperadminOtpDto, SuperadminPasswordDto } from './auth.dto';
import { SuperadminSessionGuard } from './session.guard';
import type { AuthenticatedRequest } from './request.types';
import { hashToken } from './security.util';

const ADMIN_COOKIE = 'lp_admin_session';
const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;

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

@Controller('admin/auth')
export class SuperadminAuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('password')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async verifyPassword(@Body() dto: SuperadminPasswordDto, @Req() request: AuthenticatedRequest) {
    assertSameOrigin(request);
    const challenge = await this.auth.requestSuperadminOtp(dto, request.ip);
    return { data: { ...challenge, expiresInSeconds: 300 } };
  }

  @Post('otp')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async verifyOtp(
    @Body() dto: SuperadminOtpDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    assertSameOrigin(request);
    const result = await this.auth.verifySuperadminOtp(dto, request.ip);
    response.cookie(ADMIN_COOKIE, result.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'strict',
      path: '/',
      maxAge: ADMIN_SESSION_MS,
    });
    return { data: result.principal };
  }

  @Get('me')
  @UseGuards(SuperadminSessionGuard)
  getCurrentSuperadmin(@Req() request: AuthenticatedRequest) {
    const principal = request.principal!;
    return { data: { id: principal.id, role: principal.role, email: principal.email } };
  }

  @Post('logout')
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    assertSameOrigin(request);
    response.clearCookie(ADMIN_COOKIE, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'strict',
      path: '/',
    });
    const token = request.cookies?.[ADMIN_COOKIE] as string | undefined;
    if (token) await this.auth.logoutSuperadmin(hashToken(token), request.ip);
    return { data: { loggedOut: true } };
  }
}