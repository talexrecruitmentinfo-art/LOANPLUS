import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AuthenticatedRequest } from '../auth/request.types';
import { CustomerSessionGuard, SuperadminSessionGuard } from '../auth/session.guard';
import { AcceptLoanOfferDto, ConfirmManualDisbursementDto, CreateLoanApplicationDto, CreateLoanProductDto, ReviewLoanApplicationDto, UpdateLoanProductDto } from './loan.dto';
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
  async submitApplication(@Body() dto: CreateLoanApplicationDto, @Req() request: AuthenticatedRequest) {
    return { data: await this.loans.createApplication(request.principal!.id, dto) };
  }

  @Get('applications')
  @UseGuards(CustomerSessionGuard)
  async listOwnApplications(@Req() request: AuthenticatedRequest) {
    return { data: await this.loans.listMyApplications(request.principal!.id) };
  }

  @Post('applications/:id/accept')
  @UseGuards(CustomerSessionGuard)
  async acceptOffer(
    @Param('id') id: string,
    @Body() dto: AcceptLoanOfferDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return { data: await this.loans.acceptOffer(request.principal!.id, id, dto) };
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