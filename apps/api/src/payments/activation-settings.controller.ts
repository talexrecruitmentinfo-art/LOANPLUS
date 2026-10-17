import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { AuthenticatedRequest } from '../auth/request.types';
import { SuperadminSessionGuard } from '../auth/session.guard';
import { ActivationSettingsService } from './activation-settings.service';
import { ConfigureActivationDto } from './payment.dto';

@Controller('admin/settings/activation')
@UseGuards(SuperadminSessionGuard)
export class ActivationSettingsController {
  constructor(private readonly settings: ActivationSettingsService) {}

  @Get()
  async getSettings() {
    return { data: await this.settings.getSettings() };
  }

  @Patch()
  async configure(@Body() dto: ConfigureActivationDto, @Req() request: AuthenticatedRequest) {
    return { data: await this.settings.configure(dto, request.principal!.id, request.ip) };
  }
}