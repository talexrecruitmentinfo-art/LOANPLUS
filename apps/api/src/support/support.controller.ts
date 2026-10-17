import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AuthenticatedRequest } from '../auth/request.types';
import { CustomerSessionGuard, SuperadminSessionGuard } from '../auth/session.guard';
import { CreateSupportTicketDto, ReplySupportTicketDto } from './support.dto';
import { SupportService } from './support.service';

@Controller('support/tickets')
@UseGuards(CustomerSessionGuard)
export class CustomerSupportController {
  constructor(private readonly support: SupportService) {}

  @Get()
  async listOwnTickets(@Req() request: AuthenticatedRequest) {
    return { data: await this.support.listCustomerTickets(request.principal!.id) };
  }

  @Post()
  async createTicket(@Body() dto: CreateSupportTicketDto, @Req() request: AuthenticatedRequest) {
    return { data: await this.support.createTicket(request.principal!.id, dto) };
  }
}

@Controller('admin/support/tickets')
@UseGuards(SuperadminSessionGuard)
export class AdminSupportController {
  constructor(private readonly support: SupportService) {}

  @Get()
  async listTickets() {
    return { data: await this.support.listTicketsForAdmin() };
  }

  @Patch(':id/reply')
  async reply(
    @Param('id') id: string,
    @Body() dto: ReplySupportTicketDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return { data: await this.support.replyToTicket(id, dto, request.principal!.id, request.ip) };
  }
}