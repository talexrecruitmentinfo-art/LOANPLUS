import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthenticatedRequest } from '../auth/request.types';
import { CustomerSessionGuard } from '../auth/session.guard';
import { InitiateLoanProcessingFeeDto, WalletDepositDto } from './payment.dto';
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

  @Get('loan-processing-fee-quote')
  async getLoanProcessingFeeQuote() {
    return { data: await this.payments.getLoanProcessingFeeQuote() };
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

  @Get('wallet-deposit-quote')
  async getWalletDepositQuote(@Query('amountKes') amountKes?: string) {
    if (amountKes === undefined) return { data: await this.payments.getWalletDepositQuote() };
    if (!/^[1-9]\d*$/.test(amountKes)) {
      throw new BadRequestException('Enter a positive whole-KSh deposit amount.');
    }
    const amount = Number(amountKes);
    if (!Number.isSafeInteger(amount)) {
      throw new BadRequestException('Enter a positive whole-KSh deposit amount.');
    }
    return { data: await this.payments.getWalletDepositQuote(amount) };
  }

  @Post('wallet-deposits')
  @UseGuards(CustomerSessionGuard)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async initiateWalletDeposit(
    @Body() dto: WalletDepositDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    assertSameOrigin(request);
    return { data: await this.payments.initiateWalletDeposit(request.principal!.id, dto, idempotencyKey) };
  }

  @Get('wallet-deposits/:reference')
  @UseGuards(CustomerSessionGuard)
  async getWalletDepositStatus(
    @Param('reference') reference: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return { data: await this.payments.getWalletDepositStatus(request.principal!.id, reference) };
  }

  @Get()
  @UseGuards(CustomerSessionGuard)
  async listOwnPayments(@Req() request: AuthenticatedRequest) {
    return { data: await this.payments.listCustomerPayments(request.principal!.id) };
  }

  @Get('loan-processing-fee/unresolved')
  @UseGuards(CustomerSessionGuard)
  async getUnresolvedLoanProcessingFee(@Req() request: AuthenticatedRequest) {
    return { data: await this.payments.getUnresolvedLoanProcessingFeePayment(request.principal!.id) };
  }

  @Post('mpesa/callback/:token')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async mpesaCallback(@Param('token') token: string, @Body() payload: unknown) {
    return this.payments.handleMpesaCallback(token, payload);
  }
}