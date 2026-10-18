import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';
import { SuperadminSessionGuard } from '../auth/session.guard';
import { AdminService } from './admin.service';

@Controller('admin')
@UseGuards(SuperadminSessionGuard)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('dashboard')
  async getDashboard() {
    return { data: await this.admin.getDashboard() };
  }

  @Get('audit')
  async getAudit(@Query('limit') limit?: string) {
    const parsed = limit ? Number(limit) : 50;
    return { data: await this.admin.getAuditEvents(Number.isFinite(parsed) ? parsed : 50) };
  }

  @Get('customers')
  async listCustomers(@Query('search') search?: string) {
    return { data: await this.admin.listCustomers(search) };
  }

  @Get('payments')
  async listPayments(@Query('search') search?: string, @Query('status') status?: string) {
    if (status && !Object.values(PaymentStatus).includes(status as PaymentStatus)) {
      throw new BadRequestException('Payment status filter is invalid.');
    }
    return { data: await this.admin.listPayments(search, status as PaymentStatus | undefined) };
  }
}