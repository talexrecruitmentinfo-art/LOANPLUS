import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminPlatformSettingsController, CustomerPlatformController } from './platform-settings.controller';
import { PlatformSettingsService } from './platform-settings.service';

@Module({
  imports: [AuthModule],
  controllers: [AdminController, AdminPlatformSettingsController, CustomerPlatformController],
  providers: [AdminService, PlatformSettingsService],
})
export class AdminModule {}