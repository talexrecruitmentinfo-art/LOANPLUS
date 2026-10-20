import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminPlatformSettingsController, CustomerPlatformController } from './platform-settings.controller';
import { PlatformSettingsService } from './platform-settings.service';
import { AdminSystemHealthController } from './system-health.controller';
import { SystemHealthService } from './system-health.service';
import { StaffAccountsController, StaffInvitationSetupController } from './staff-accounts.controller';
import { StaffAccountsService } from './staff-accounts.service';

@Module({
  imports: [AuthModule],
  controllers: [
    AdminController,
    AdminPlatformSettingsController,
    CustomerPlatformController,
    AdminSystemHealthController,
    StaffAccountsController,
    StaffInvitationSetupController,
  ],
  providers: [AdminService, PlatformSettingsService, SystemHealthService, StaffAccountsService],
})
export class AdminModule {}