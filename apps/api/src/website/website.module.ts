import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminWebsiteController, PublicWebsiteController } from './website.controller';
import { WebsiteService } from './website.service';

@Module({
  imports: [AuthModule],
  controllers: [PublicWebsiteController, AdminWebsiteController],
  providers: [WebsiteService],
})
export class WebsiteModule {}
