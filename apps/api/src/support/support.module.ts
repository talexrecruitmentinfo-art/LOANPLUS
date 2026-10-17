import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminSupportController, CustomerSupportController } from './support.controller';
import { SupportService } from './support.service';

@Module({
  imports: [AuthModule],
  controllers: [CustomerSupportController, AdminSupportController],
  providers: [SupportService],
})
export class SupportModule {}