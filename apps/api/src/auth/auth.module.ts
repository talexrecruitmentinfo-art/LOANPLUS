import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MailService } from './mail.service';
import { CustomerSessionGuard, SuperadminSessionGuard } from './session.guard';
import { SuperadminAuthController } from './superadmin-auth.controller';

@Module({
  controllers: [AuthController, SuperadminAuthController],
  providers: [AuthService, MailService, CustomerSessionGuard, SuperadminSessionGuard],
  exports: [AuthService, CustomerSessionGuard, SuperadminSessionGuard, MailService],
})
export class AuthModule {}