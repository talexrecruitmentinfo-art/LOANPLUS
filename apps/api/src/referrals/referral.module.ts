import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CustomerReferralController, AdminReferralController } from './referral.controller';
import { ReferralService } from './referral.service';

@Module({
  imports: [AuthModule],
  controllers: [CustomerReferralController, AdminReferralController],
  providers: [ReferralService],
})
export class ReferralModule {}