import { ReferralService } from './referral.service';
import type { PrismaService } from '../prisma/prisma.service';

describe('customer referral overview', () => {
  it('does not return the referred customer account activation status', async () => {
    const findUnique = jest.fn().mockResolvedValue({ referralCode: 'REFERRAL01' });
    const findMany = jest.fn().mockResolvedValue([{
      id: 'referral-id',
      status: 'REGISTERED',
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      referredUser: { fullName: 'Referred Customer' },
      reward: null,
    }]);
    const prisma = {
      user: { findUnique },
      referral: { findMany },
    } as unknown as PrismaService;
    const service = new ReferralService(prisma);

    const overview = await service.getCustomerOverview('referrer-id');

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({
        id: true,
        status: true,
        createdAt: true,
        referredUser: { select: { fullName: true } },
        reward: { select: { status: true } },
      }),
    }));
    expect(overview.referrals[0]?.referredUser).toEqual({ fullName: 'Referred Customer' });
  });
});
