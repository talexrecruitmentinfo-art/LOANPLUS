import { Body, Controller, ForbiddenException, Get, Headers, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthenticatedRequest } from '../auth/request.types';
import { CustomerSessionGuard } from '../auth/session.guard';
import { InitiateActivationPaymentDto } from './payment.dto';
import { PaymentService } from './payment.service';

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

@Controller('payments')
export class PaymentController {
  constructor(private readonly payments: PaymentService) {}

  @Get('activation/terms')
  async getActivationTerms() {
    return { data: await this.payments.getActivationTerms() };
  }

  @Post('activation')
  @UseGuards(CustomerSessionGuard)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async initiateActivation(
    @Body() dto: InitiateActivationPaymentDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    assertSameOrigin(request);
    return {
      data: await this.payments.initiateActivationPayment(request.principal!.id, dto, idempotencyKey),
    };
  }

  @Get()
  @UseGuards(CustomerSessionGuard)
  async listOwnPayments(@Req() request: AuthenticatedRequest) {
    return { data: await this.payments.listCustomerPayments(request.principal!.id) };
  }

  @Post('mpesa/callback/:token')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async mpesaCallback(@Param('token') token: string, @Body() payload: unknown) {
    return this.payments.handleMpesaCallback(token, payload);
  }
}