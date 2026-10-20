import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import type { AuthenticatedRequest } from '../auth/request.types';
import { assertSameOrigin } from '../auth/request-origin.util';
import { SuperadminSessionGuard } from '../auth/session.guard';
import { STAFF_ROLES, type StaffRole, StaffAccountsService } from './staff-accounts.service';

class CreateStaffAccountDto {
  @IsString()
  @Length(2, 160)
  fullName!: string;

  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsOptional()
  @IsString()
  @Matches(/^\+?[\d ()-]{9,18}$/)
  phone?: string;

  @IsIn(STAFF_ROLES)
  role!: StaffRole;

  @IsString()
  @Length(10, 500)
  reason!: string;
}

class UpdateStaffDetailsDto {
  @IsString()
  @Length(2, 160)
  fullName!: string;

  @IsOptional()
  @IsString()
  @Matches(/^\+?[\d ()-]{9,18}$/)
  phone?: string;

  @IsString()
  @Length(10, 500)
  reason!: string;
}

class UpdateStaffRoleDto {
  @IsIn(STAFF_ROLES)
  role!: StaffRole;

  @IsString()
  @Length(10, 500)
  reason!: string;
}

class UpdateStaffStatusDto {
  @IsBoolean()
  isActive!: boolean;

  @IsString()
  @Length(10, 500)
  reason!: string;
}

class StaffActionReasonDto {
  @IsString()
  @Length(10, 500)
  reason!: string;
}

class CompleteStaffInvitationDto {
  @IsString()
  @Length(32, 64)
  @Matches(/^[A-Za-z0-9_-]+$/)
  token!: string;

  @IsString()
  @Length(12, 72)
  password!: string;

  @IsString()
  @Length(12, 72)
  confirmPassword!: string;
}

@Controller('admin/staff')
@UseGuards(SuperadminSessionGuard)
export class StaffAccountsController {
  constructor(private readonly staff: StaffAccountsService) {}

  @Get()
  async list(@Query('search') search?: string) {
    return { data: await this.staff.listStaff(search) };
  }

  @Post()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async create(@Body() dto: CreateStaffAccountDto, @Req() request: AuthenticatedRequest) {
    assertSameOrigin(request);
    return {
      data: await this.staff.createStaff(dto, request.principal!.id, request.ip),
    };
  }

  @Patch(':id')
  async updateDetails(
    @Param('id') id: string,
    @Body() dto: UpdateStaffDetailsDto,
    @Req() request: AuthenticatedRequest,
  ) {
    assertSameOrigin(request);
    return {
      data: await this.staff.updateStaffDetails(id, dto, request.principal!.id, dto.reason, request.ip),
    };
  }

  @Patch(':id/role')
  async updateRole(
    @Param('id') id: string,
    @Body() dto: UpdateStaffRoleDto,
    @Req() request: AuthenticatedRequest,
  ) {
    assertSameOrigin(request);
    return {
      data: await this.staff.updateStaffRole(id, dto.role, request.principal!.id, dto.reason, request.ip),
    };
  }

  @Patch(':id/status')
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateStaffStatusDto,
    @Req() request: AuthenticatedRequest,
  ) {
    assertSameOrigin(request);
    return {
      data: await this.staff.updateStaffStatus(id, dto.isActive, request.principal!.id, dto.reason, request.ip),
    };
  }

  @Post(':id/sessions/revoke')
  async revokeSessions(
    @Param('id') id: string,
    @Body() dto: StaffActionReasonDto,
    @Req() request: AuthenticatedRequest,
  ) {
    assertSameOrigin(request);
    return {
      data: await this.staff.revokeStaffSessions(id, request.principal!.id, dto.reason, request.ip),
    };
  }

  @Post(':id/invitations/resend')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async resendInvitation(
    @Param('id') id: string,
    @Body() dto: StaffActionReasonDto,
    @Req() request: AuthenticatedRequest,
  ) {
    assertSameOrigin(request);
    return {
      data: await this.staff.resendInvitation(id, request.principal!.id, dto.reason, request.ip),
    };
  }

  @Post(':id/invitations/:invitationId/revoke')
  async revokeInvitation(
    @Param('id') id: string,
    @Param('invitationId') invitationId: string,
    @Body() dto: StaffActionReasonDto,
    @Req() request: AuthenticatedRequest,
  ) {
    assertSameOrigin(request);
    return {
      data: await this.staff.revokeInvitation(
        id,
        invitationId,
        request.principal!.id,
        dto.reason,
        request.ip,
      ),
    };
  }

  @Get(':id/audit')
  async getAuditHistory(@Param('id') id: string) {
    return { data: await this.staff.getStaffAuditHistory(id) };
  }
}

@Controller('admin/staff/invitations')
export class StaffInvitationSetupController {
  constructor(private readonly staff: StaffAccountsService) {}

  @Post('setup')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async completeSetup(@Body() dto: CompleteStaffInvitationDto, @Req() request: AuthenticatedRequest) {
    return {
      data: await this.staff.completeInvitation(dto.token, dto.password, dto.confirmPassword, request.ip),
    };
  }
}
