import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminLedgerController, CustomerLedgerController } from './ledger.controller';
import { LedgerService } from './ledger.service';

@Module({
  imports: [AuthModule],
  controllers: [CustomerLedgerController, AdminLedgerController],
  providers: [LedgerService],
  exports: [LedgerService],
})
export class LedgerModule {}