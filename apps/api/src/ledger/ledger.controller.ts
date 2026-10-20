import { BadRequestException, Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsEnum, IsString, Length, Matches } from 'class-validator';
import { LedgerAccountType } from '@prisma/client';
import { AuthenticatedRequest } from '../auth/request.types';
import { CustomerSessionGuard, SuperadminSessionGuard } from '../auth/session.guard';
import { LedgerService } from './ledger.service';

class CreateLedgerAccountDto {
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{2,39}$/)
  code!: string;

  @IsString()
  @Length(3, 120)
  name!: string;

  @IsEnum(LedgerAccountType)
  accountType!: LedgerAccountType;

  @IsString()
  @Length(10, 500)
  reason!: string;
}

@Controller('wallet')
@UseGuards(CustomerSessionGuard)
export class CustomerLedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @Get()
  async getWallet(@Req() request: AuthenticatedRequest) {
    return { data: await this.ledger.getCustomerWallet(request.principal!.id) };
  }

  @Get('transactions')
  async listTransactions(
    @Req() request: AuthenticatedRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = limit === undefined ? 25 : Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      throw new BadRequestException('Wallet transaction page size must be between 1 and 100.');
    }
    if (cursor !== undefined && (cursor.length < 1 || cursor.length > 40)) {
      throw new BadRequestException('Wallet transaction cursor is invalid.');
    }
    return { data: await this.ledger.listCustomerEntries(request.principal!.id, cursor, parsedLimit) };
  }
}

@Controller('admin/ledger/accounts')
@UseGuards(SuperadminSessionGuard)
export class AdminLedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @Get()
  async listAccounts() {
    return { data: await this.ledger.listSystemAccounts() };
  }

  @Post()
  async createAccount(@Body() dto: CreateLedgerAccountDto, @Req() request: AuthenticatedRequest) {
    return {
      data: await this.ledger.createSystemAccount(dto, request.principal!.id, request.ip),
    };
  }
}