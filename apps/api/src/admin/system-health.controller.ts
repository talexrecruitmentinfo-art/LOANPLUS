import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsString, Length } from 'class-validator';
import type { AuthenticatedRequest } from '../auth/request.types';
import { SuperadminSessionGuard } from '../auth/session.guard';
import { SystemHealthService } from './system-health.service';

class IncidentNoteDto {
  @IsString()
  @Length(10, 1000)
  note!: string;
}

class AcknowledgeIncidentDto {
  @IsString()
  @Length(10, 500)
  reason!: string;
}

@Controller('admin/system-health')
@UseGuards(SuperadminSessionGuard)
export class AdminSystemHealthController {
  constructor(private readonly health: SystemHealthService) {}

  @Get()
  async getDashboard(
    @Query('search') search?: string,
    @Query('severity') severity?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const parsedPage = page === undefined ? 1 : Number(page);
    const parsedPageSize = pageSize === undefined ? 20 : Number(pageSize);
    if (!Number.isSafeInteger(parsedPage) || parsedPage < 1 || parsedPage > 100_000) {
      throw new BadRequestException('Incident page must be a positive integer.');
    }
    if (!Number.isSafeInteger(parsedPageSize) || parsedPageSize < 1 || parsedPageSize > 100) {
      throw new BadRequestException('Incident page size must be between 1 and 100.');
    }
    if (severity && !['INFO', 'WARNING', 'ERROR', 'CRITICAL'].includes(severity)) {
      throw new BadRequestException('Incident severity filter is invalid.');
    }
    if (status && !['OPEN', 'ACKNOWLEDGED', 'RESOLVED'].includes(status)) {
      throw new BadRequestException('Incident status filter is invalid.');
    }
    return {
      data: await this.health.getDashboard({ search, severity, status, page: parsedPage, pageSize: parsedPageSize }),
    };
  }

  @Post('check')
  async runChecks(@Req() request: AuthenticatedRequest) {
    return { data: await this.health.runChecks(request.principal!.id, request.ip) };
  }

  @Post('incidents/:id/notes')
  async addIncidentNote(
    @Param('id') incidentId: string,
    @Body() dto: IncidentNoteDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.health.addIncidentNote(incidentId, request.principal!.id, dto.note, request.ip),
    };
  }

  @Post('incidents/:id/acknowledge')
  async acknowledgeIncident(
    @Param('id') incidentId: string,
    @Body() dto: AcknowledgeIncidentDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.health.acknowledgeIncident(incidentId, request.principal!.id, dto.reason, request.ip),
    };
  }
}
