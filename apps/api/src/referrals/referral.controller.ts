import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { AuthenticatedRequest } from '../auth/request.types';
import { CustomerSessionGuard, SuperadminSessionGuard } from '../auth/session.guard';
import { ReferralService } from './referral.service';

@Controller('referrals')
@UseGuards(CustomerSessionGuard)
export class CustomerReferralController {
  constructor(private readonly referrals: ReferralService) {}

  @Get('me')
  async getMyReferrals(@Req() request: AuthenticatedRequest) {
    return { data: await this.referrals.getCustomerOverview(request.principal!.id) };
  }
}

@Controller('admin/referrals')
@UseGuards(SuperadminSessionGuard)
export class AdminReferralController {
  constructor(private readonly referrals: ReferralService) {}

  @Get()
  async listReferrals() {
    return { data: await this.referrals.listForAdmin() };
  }
}