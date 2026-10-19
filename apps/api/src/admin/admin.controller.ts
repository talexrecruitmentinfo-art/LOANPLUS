import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IdentityStatus, PaymentStatus, PaymentType } from '@prisma/client';
import { IsBoolean, IsDateString, IsIn, IsString, Length, MaxLength, MinLength } from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import type { AuthenticatedRequest } from '../auth/request.types';
import { AuthService } from '../auth/auth.service';
import { SuperadminSessionGuard } from '../auth/session.guard';
import { AdminService } from './admin.service';

class UpdateCustomerStatusDto {
  @IsBoolean()
  isActive!: boolean;

  @IsString()
  @Length(10, 500)
  reason!: string;
}

class UpdateCustomerProfileDto {
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  fullName!: string;

  @IsDateString()
  expectedUpdatedAt!: string;

  @IsString()
  @Length(10, 500)
  reason!: string;
}

class UpdateCustomerIdentityStatusDto {
  @IsIn([IdentityStatus.VERIFIED, IdentityStatus.REJECTED])
  status!: IdentityStatus;

  @IsString()
  @Length(10, 500)
  reason!: string;

  @IsBoolean()
  reviewConfirmed!: boolean;
}

class CustomerPasswordResetDto {
  @IsString()
  @Length(10, 500)
  reason!: string;
}

function parsePage(value?: string): number {
  const parsed = value === undefined ? 1 : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100_000) {
    throw new BadRequestException('Page must be a positive integer.');
  }
  return parsed;
}

function parsePageSize(value?: string): number {
  const parsed = value === undefined ? 25 : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new BadRequestException('Page size must be between 1 and 100.');
  }
  return parsed;
}

function parseDate(value: string | undefined, name: string, endOfDay = false): Date | undefined {
  if (!value) return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  // Date-only Admin filters use the portal's Kenya timezone.
  const parsed = new Date(dateOnly ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+03:00` : value);
  if (Number.isNaN(parsed.getTime())) throw new BadRequestException(`${name} must be a valid date.`);
  return parsed;
}

@Controller('admin')
@UseGuards(SuperadminSessionGuard)
export class AdminController {
  constructor(private readonly admin: AdminService, private readonly auth: AuthService) {}

  @Get('dashboard')
  async getDashboard() {
    return { data: await this.admin.getDashboard() };
  }

  @Get('audit')
  async getAudit(
    @Query('search') search?: string,
    @Query('actorId') actorId?: string,
    @Query('action') action?: string,
    @Query('resourceType') resourceType?: string,
    @Query('outcome') outcome?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const start = parseDate(from, 'Audit start date');
    const end = parseDate(to, 'Audit end date', true);
    if (start && end && start > end) throw new BadRequestException('Audit date range is invalid.');
    return {
      data: await this.admin.getAuditEvents({
        search,
        actorId,
        action,
        resourceType,
        outcome,
        from: start,
        to: end,
        page: parsePage(page),
        pageSize: parsePageSize(pageSize),
      }),
    };
  }

  @Get('customers')
  async listCustomers(
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('accountStatus') accountStatus?: string,
    @Query('identityStatus') identityStatus?: string,
    @Query('registeredFrom') registeredFrom?: string,
    @Query('registeredTo') registeredTo?: string,
  ) {
    if (accountStatus && accountStatus !== 'ACTIVE' && accountStatus !== 'DISABLED') {
      throw new BadRequestException('Account status filter is invalid.');
    }
    if (identityStatus && !Object.values(IdentityStatus).includes(identityStatus as IdentityStatus)) {
      throw new BadRequestException('Identity status filter is invalid.');
    }
    const start = parseDate(registeredFrom, 'Registration start');
    const end = parseDate(registeredTo, 'Registration end', true);
    if (start && end && start > end) throw new BadRequestException('Registration date range is invalid.');
    return {
      data: await this.admin.listCustomers({
        search,
        page: parsePage(page),
        pageSize: parsePageSize(pageSize),
        accountStatus: accountStatus as 'ACTIVE' | 'DISABLED' | undefined,
        identityStatus: identityStatus as IdentityStatus | undefined,
        registeredFrom: start,
        registeredTo: end,
      }),
    };
  }

  @Get('customers/:id')
  async getCustomer(@Param('id') id: string) {
    return { data: await this.admin.getCustomerDetails(id) };
  }

  @Patch('customers/:id/status')
  async updateCustomerStatus(
    @Param('id') id: string,
    @Body() dto: UpdateCustomerStatusDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.admin.updateCustomerStatus(
        id,
        dto.isActive,
        dto.reason,
        request.principal!.id,
        request.ip,
      ),
    };
  }

  @Patch('customers/:id/identity-status')
  async updateCustomerIdentityStatus(
    @Param('id') id: string,
    @Body() dto: UpdateCustomerIdentityStatusDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.admin.updateCustomerIdentityStatus(
        id,
        dto.status,
        dto.reason,
        dto.reviewConfirmed,
        request.principal!.id,
        request.ip,
      ),
    };
  }

  @Patch('customers/:id/profile')
  async updateCustomerProfile(
    @Param('id') id: string,
    @Body() dto: UpdateCustomerProfileDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.admin.updateCustomerProfile(
        id,
        dto.fullName,
        dto.expectedUpdatedAt,
        dto.reason,
        request.principal!.id,
        request.ip,
      ),
    };
  }

  @Post('customers/:id/password-reset')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async requestCustomerPasswordReset(
    @Param('id') id: string,
    @Body() dto: CustomerPasswordResetDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.auth.requestCustomerPasswordReset(
        id,
        request.principal!.id,
        dto.reason,
        request.ip,
      ),
    };
  }

  @Get('payments')
  async listPayments(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('type') type?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (status && !Object.values(PaymentStatus).includes(status as PaymentStatus)) {
      throw new BadRequestException('Payment status filter is invalid.');
    }
    if (type && !Object.values(PaymentType).includes(type as PaymentType)) {
      throw new BadRequestException('Payment type filter is invalid.');
    }
    const start = parseDate(from, 'Start date');
    const end = parseDate(to, 'End date', true);
    if (start && end && start > end) throw new BadRequestException('Payment date range is invalid.');
    return {
      data: await this.admin.listPayments({
        search,
        status: status as PaymentStatus | undefined,
        type: type as PaymentType | undefined,
        page: parsePage(page),
        pageSize: parsePageSize(pageSize),
        from: start,
        to: end,
      }),
    };
  }
}