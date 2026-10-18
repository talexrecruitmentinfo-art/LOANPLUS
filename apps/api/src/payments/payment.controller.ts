import { Body, Controller, ForbiddenException, Get, Headers, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthenticatedRequest } from '../auth/request.types';
import { CustomerSessionGuard } from '../auth/session.guard';
import { InitiateLoanProcessingFeeDto } from './payment.dto';
import { PaymentService } from './payment.service';
import { getLoanProcessingFeePolicy, LOAN_PROCESSING_FEE_KES } from './processing-fee.constants';

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

  @Get('loan-processing-fee-quote')
  async getLoanProcessingFeeQuote() {
    const policy = getLoanProcessingFeePolicy();
    return {
      data: {
        amountKes: LOAN_PROCESSING_FEE_KES,
        currency: 'KES',
        refundPolicyStatus: policy.status,
        refundPolicyVersion: policy.version,
        refundPolicyDisclosure: policy.disclosure,
      },
    };
  }

  @Post('loan-processing-fee')
  @UseGuards(CustomerSessionGuard)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async initiateLoanProcessingFee(
    @Body() dto: InitiateLoanProcessingFeeDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    assertSameOrigin(request);
    return {
      data: await this.payments.initiateLoanProcessingFee(request.principal!.id, dto, idempotencyKey),
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