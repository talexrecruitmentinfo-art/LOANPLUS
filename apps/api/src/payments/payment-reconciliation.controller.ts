import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Equals, IsBoolean, IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';
import type { AuthenticatedRequest } from '../auth/request.types';
import { SuperadminSessionGuard } from '../auth/session.guard';
import { PaymentService, type ReconciliationQueueCategory } from './payment.service';

class ReconcilePaymentDto {
  @IsString()
  @Length(10, 500)
  note!: string;

  @IsOptional()
  @IsString()
  @Length(12, 12)
  accountReference?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  checkoutRequestId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  merchantRequestId?: string;

  @IsOptional()
  @IsIn(['SAFARICOM_PORTAL', 'SAFARICOM_SUPPORT'])
  evidenceSource?: 'SAFARICOM_PORTAL' | 'SAFARICOM_SUPPORT';

  @IsOptional()
  @IsString()
  @Length(3, 100)
  @Matches(/^[A-Za-z0-9._:/-]+$/)
  evidenceReference?: string;
}

class VerifyProviderEvidenceDto {
  @IsString()
  @Length(1, 40)
  evidenceAttemptId!: string;

  @IsString()
  @Length(10, 500)
  note!: string;

  @IsBoolean()
  @Equals(true)
  evidenceReviewed!: boolean;
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

function parseQueueCategory(value?: string): ReconciliationQueueCategory {
  if (!value || value === 'ALL') return 'ALL';
  if (value === 'AGED_PENDING' || value === 'LEGACY_4999' || value === 'PROVIDER_REVIEW') return value;
  throw new BadRequestException('Reconciliation category is invalid.');
}

@Controller('admin/payment-reconciliation')
@UseGuards(SuperadminSessionGuard)
export class PaymentReconciliationController {
  constructor(private readonly payments: PaymentService) {}

  @Get()
  async list(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('category') category?: string,
  ) {
    const parsedLimit = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      throw new BadRequestException('Reconciliation page size must be between 1 and 100.');
    }
    if (cursor !== undefined && (cursor.length < 1 || cursor.length > 40)) {
      throw new BadRequestException('Reconciliation cursor is invalid.');
    }
    return {
      data: await this.payments.listReconciliationQueue(
        cursor,
        parsedLimit,
        search,
        parseQueueCategory(category),
      ),
    };
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
        dto.checkoutRequestId !== undefined || dto.merchantRequestId !== undefined
          ? {
              accountReference: dto.accountReference ?? '',
              checkoutRequestId: dto.checkoutRequestId ?? '',
              merchantRequestId: dto.merchantRequestId ?? '',
              evidenceSource: dto.evidenceSource,
              evidenceReference: dto.evidenceReference,
            }
          : undefined,
      ),
    };
  }

  @Post(':paymentId/verify-evidence')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async verifyEvidence(
    @Param('paymentId') paymentId: string,
    @Body() dto: VerifyProviderEvidenceDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    assertSameOrigin(request);
    return {
      data: await this.payments.verifyUncertainProcessingFeeEvidence(
        paymentId,
        dto.evidenceAttemptId,
        idempotencyKey,
        request.principal!.id,
        dto.note,
        dto.evidenceReviewed,
        request.ip,
      ),
    };
  }

  @Post(':paymentId/escalate')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async escalate(
    @Param('paymentId') paymentId: string,
    @Body() dto: ReconcilePaymentDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    assertSameOrigin(request);
    return {
      data: await this.payments.escalateActivationPayment(
        paymentId,
        idempotencyKey,
        request.principal!.id,
        dto.note,
        request.ip,
      ),
    };
  }
}
