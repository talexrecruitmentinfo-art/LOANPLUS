import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LedgerModule } from '../ledger/ledger.module';
import { MpesaService } from './mpesa.service';
import { PaymentReconciliationController } from './payment-reconciliation.controller';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';

@Module({
  imports: [AuthModule, LedgerModule],
  controllers: [PaymentController, PaymentReconciliationController],
  providers: [PaymentService, MpesaService],
})
export class PaymentModule {}