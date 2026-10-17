import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LedgerModule } from '../ledger/ledger.module';
import { ActivationSettingsController } from './activation-settings.controller';
import { ActivationSettingsService } from './activation-settings.service';
import { MpesaService } from './mpesa.service';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';

@Module({
  imports: [AuthModule, LedgerModule],
  controllers: [PaymentController, ActivationSettingsController],
  providers: [PaymentService, MpesaService, ActivationSettingsService],
})
export class PaymentModule {}