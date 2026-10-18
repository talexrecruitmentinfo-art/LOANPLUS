import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsString, Length } from 'class-validator';
import type { AuthenticatedRequest } from '../auth/request.types';
import { SuperadminSessionGuard } from '../auth/session.guard';
import { PaymentService } from './payment.service';

class ReconcilePaymentDto {
  @IsString()
  @Length(10, 500)
  note!: string;
}

function assertSameOrigin(request: AuthenticatedRequest): void {
  const expected = new URL(process.env.WEB_ORIGIN ?? 'http://localhost:3000').origin;
  const origin = request.headers.origin;
  if (!origin) throw new ForbiddenException('Request origin rejected.');
  try {
    if (new URL(origin).origin !== expected) throw new ForbiddenException('Request origin rejected.');
  } catch {
    throw new ForbiddenException('Request origin rejected.');
  }
}

@Controller('admin/payment-reconciliation')
@UseGuards(SuperadminSessionGuard)
export class PaymentReconciliationController {
  constructor(private readonly payments: PaymentService) {}

  @Get()
  async list(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      throw new BadRequestException('Reconciliation page size must be between 1 and 100.');
    }
    if (cursor !== undefined && (cursor.length < 1 || cursor.length > 40)) {
      throw new BadRequestException('Reconciliation cursor is invalid.');
    }
    return { data: await this.payments.listReconciliationQueue(cursor, parsedLimit) };
  }

  @Post(':paymentId/refresh')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async reconcile(
    @Param('paymentId') paymentId: string,
    @Body() dto: ReconcilePaymentDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    assertSameOrigin(request);
    return {
      data: await this.payments.reconcileActivationPayment(
        paymentId,
        idempotencyKey,
        request.principal!.id,
        dto.note,
        request.ip,
      ),
    };
  }
}
