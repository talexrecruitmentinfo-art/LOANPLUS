import { Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ReferralService {
  constructor(private readonly prisma: PrismaService) {}

  async getCustomerOverview(userId: string) {
    let customer = await this.prisma.user.findUnique({ where: { id: userId }, select: { referralCode: true } });
    if (!customer) throw new NotFoundException('Customer account was not found.');
    if (!customer.referralCode) {
      for (let attempt = 0; attempt < 3 && !customer.referralCode; attempt += 1) {
        await this.prisma.user.updateMany({
          where: { id: userId, referralCode: null },
          data: { referralCode: randomBytes(8).toString('hex').toUpperCase() },
        });
        customer = await this.prisma.user.findUnique({ where: { id: userId }, select: { referralCode: true } });
        if (!customer) throw new NotFoundException('Customer account was not found.');
      }
    }
    if (!customer.referralCode) throw new NotFoundException('Referral link could not be created.');
    const referrals = await this.prisma.referral.findMany({
      where: { referrerId: userId },
      select: {
        id: true,
        status: true,
        createdAt: true,
        referredUser: { select: { fullName: true } },
        reward: { select: { status: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const link = new URL('/register', process.env.WEB_ORIGIN ?? 'http://localhost:3000');
    link.searchParams.set('ref', customer.referralCode);
    return {
      referralCode: customer.referralCode,
      referralLink: link.toString(),
      total: referrals.length,
      qualified: referrals.filter((referral) => referral.status === 'QUALIFIED' || referral.status === 'REWARDED').length,
      referrals,
      rewardsConfigured: false,
    };
  }

  listForAdmin() {
    return this.prisma.referral.findMany({
      include: {
        referrer: { select: { id: true, fullName: true, email: true } },
        referredUser: { select: { id: true, fullName: true, email: true } },
        reward: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
  }
}