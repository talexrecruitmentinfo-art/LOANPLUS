import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminLoanController, CustomerLoanController } from './loan.controller';
import { LoanService } from './loan.service';

@Module({
  imports: [AuthModule],
  controllers: [CustomerLoanController, AdminLoanController],
  providers: [LoanService],
})
export class LoanModule {}