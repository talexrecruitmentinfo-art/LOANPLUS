import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsString, Length, Max, Min } from 'class-validator';
import { AuthenticatedRequest } from '../auth/request.types';
import { CustomerSessionGuard, SuperadminSessionGuard } from '../auth/session.guard';
import { PlatformSettingsService } from './platform-settings.service';

class UpdateCurrencySettingsDto {
  @IsString()
  @IsIn(['KES'])
  currencyCode!: string;

  @IsString()
  @Length(10, 500)
  reason!: string;
}

class UpdateInstallPolicyDto {
  @IsBoolean()
  enabled!: boolean;

  @IsString()
  @Length(10, 500)
  reason!: string;
}

class UpdateReconciliationThresholdDto {
  @IsInt()
  @Min(1)
  @Max(1440)
  pendingThresholdMinutes!: number;

  @IsString()
  @Length(10, 500)
  reason!: string;
}

@Controller('admin/settings/platform')
@UseGuards(SuperadminSessionGuard)
export class AdminPlatformSettingsController {
  constructor(private readonly settings: PlatformSettingsService) {}

  @Get('currency')
  async getCurrencySettings() {
    return { data: await this.settings.getCurrencySettings() };
  }

  @Patch('currency')
  async updateCurrencySettings(@Body() dto: UpdateCurrencySettingsDto, @Req() request: AuthenticatedRequest) {
    return {
      data: await this.settings.updateCurrencySettings(
        dto.currencyCode,
        dto.reason,
        request.principal!.id,
        request.ip,
      ),
    };
  }

  @Get('pwa-installation')
  async getInstallPolicy() {
    return { data: await this.settings.getInstallPolicy() };
  }

  @Patch('pwa-installation')
  async updateInstallPolicy(@Body() dto: UpdateInstallPolicyDto, @Req() request: AuthenticatedRequest) {
    return {
      data: await this.settings.updateInstallPolicy(
        dto.enabled,
        dto.reason,
        request.principal!.id,
        request.ip,
      ),
    };
  }

  @Get('reconciliation')
  async getReconciliationThreshold() {
    return { data: await this.settings.getReconciliationThreshold() };
  }

  @Patch('reconciliation')
  async updateReconciliationThreshold(
    @Body() dto: UpdateReconciliationThresholdDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.settings.updateReconciliationThreshold(
        dto.pendingThresholdMinutes,
        dto.reason,
        request.principal!.id,
        request.ip,
      ),
    };
  }
}

@Controller('platform')
@UseGuards(CustomerSessionGuard)
export class CustomerPlatformController {
  constructor(private readonly settings: PlatformSettingsService) {}

  @Get('pwa/eligibility')
  async getInstallEligibility() {
    return { data: await this.settings.getCustomerInstallEligibility() };
  }
}