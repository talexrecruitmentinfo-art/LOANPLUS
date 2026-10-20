import { Body, Controller, Get, Headers, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ForbiddenException } from '@nestjs/common';
import { AuthenticatedRequest } from '../auth/request.types';
import { AllowStaffRoles, CustomerSessionGuard, SuperadminSessionGuard } from '../auth/session.guard';
import { ConfigureLoanChargeRevenueDto, ConfigureLoanProcessingFeeDto, ConfirmManualDisbursementDto, CreateLoanApplicationDto, CreateLoanProductDto, ReviewLoanApplicationDto, UpdateLoanProductDto } from './loan.dto';
import { WalletRepaymentDto } from '../payments/payment.dto';

function assertSameOrigin(request: AuthenticatedRequest): void {
  const expected = new URL(process.env.WEB_ORIGIN ?? 'http://localhost:3000').origin;
  const origin = request.headers.origin;
  if (!origin) return;
  try {
    if (new URL(origin).origin !== expected) throw new ForbiddenException('Request origin rejected.');
  } catch {
    throw new ForbiddenException('Request origin rejected.');
  }
}
import { LoanService } from './loan.service';

@Controller('loans')
export class CustomerLoanController {
  constructor(private readonly loans: LoanService) {}

  @Get('products')
  async listAvailableProducts() {
    return { data: await this.loans.listAvailableProducts() };
  }

  @Post('applications')
  @UseGuards(CustomerSessionGuard)
  async submitApplication(
    @Body() dto: CreateLoanApplicationDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return { data: await this.loans.createApplication(request.principal!.id, dto, idempotencyKey) };
  }

  @Get('applications')
  @UseGuards(CustomerSessionGuard)
  async listOwnApplications(@Req() request: AuthenticatedRequest) {
    return { data: await this.loans.listMyApplications(request.principal!.id) };
  }

  @Get('repayments/eligible')
  @UseGuards(CustomerSessionGuard)
  async listEligibleRepayments(@Req() request: AuthenticatedRequest) {
    return { data: await this.loans.listMyEligibleRepayments(request.principal!.id) };
  }

  @Get('repayments/readiness')
  async getWalletRepaymentReadiness() {
    return { data: await this.loans.getWalletRepaymentReadiness() };
  }

  @Post(':id/repayments')
  @UseGuards(CustomerSessionGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async repayFromWallet(
    @Param('id') id: string,
    @Body() dto: WalletRepaymentDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    assertSameOrigin(request);
    return {
      data: await this.loans.repayWithWallet(
        request.principal!.id,
        id,
        dto.amountKes,
        dto.confirmed,
        idempotencyKey,
      ),
    };
  }

  @Get('repayments/:reference')
  @UseGuards(CustomerSessionGuard)
  async getRepaymentReceipt(
    @Param('reference') reference: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return { data: await this.loans.getMyWalletRepaymentReceipt(request.principal!.id, reference) };
  }
}

@Controller('admin/loans')
@UseGuards(SuperadminSessionGuard)
export class AdminLoanController {
  constructor(private readonly loans: LoanService) {}

  @Get('products')
  async listProducts() {
    return { data: await this.loans.listProductsForAdmin() };
  }

  @Get('processing-fee-settings')
  async getProcessingFeeSettings() {
    return { data: await this.loans.getProcessingFeeSettings() };
  }

  @Patch('processing-fee-settings')
  async configureProcessingFeeSettings(
    @Body() dto: ConfigureLoanProcessingFeeDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.loans.configureProcessingFeeRevenueAccount(
        dto.revenueAccountCode,
        dto.reason,
        request.principal!.id,
        request.ip,
      ),
    };
  }

  @Get('loan-charges-settings')
  async getLoanChargeRevenueSettings() {
    return { data: await this.loans.getLoanChargeRevenueSettings() };
  }

  @Patch('loan-charges-settings')
  async configureLoanChargeRevenue(
    @Body() dto: ConfigureLoanChargeRevenueDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.loans.configureLoanChargeRevenueAccount(
        dto.revenueAccountCode,
        dto.reason,
        request.principal!.id,
        request.ip,
      ),
    };
  }

  @Post('products')
  async createProduct(@Body() dto: CreateLoanProductDto, @Req() request: AuthenticatedRequest) {
    return { data: await this.loans.createProduct(dto, request.principal!.id, request.ip) };
  }

  @Patch('products/:id')
  async updateProduct(
    @Param('id') id: string,
    @Body() dto: UpdateLoanProductDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return { data: await this.loans.updateProduct(id, dto, request.principal!.id, request.ip) };
  }

  @Get('applications')
  @AllowStaffRoles('STAFF_OPERATIONS')
  async listApplications() {
    return { data: await this.loans.listApplicationsForReview() };
  }

  @Get('disbursements/pending')
  async listPendingDisbursements() {
    return { data: await this.loans.listLoansAwaitingDisbursement() };
  }

  @Patch('applications/:id/decision')
  async review(
    @Param('id') id: string,
    @Body() dto: ReviewLoanApplicationDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return { data: await this.loans.reviewApplication(id, dto, request.principal!.id, request.ip) };
  }

  @Post(':id/disbursement/confirm')
  async confirmManualDisbursement(
    @Param('id') id: string,
    @Body() dto: ConfirmManualDisbursementDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.loans.confirmManualDisbursement(id, dto, request.principal!.id, request.ip),
    };
  }
}