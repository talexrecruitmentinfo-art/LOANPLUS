import { Controller, Get, Query, UseGuards } from '@nestjs/common';
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
}