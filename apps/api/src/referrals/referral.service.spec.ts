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
      loanApplication: { findFirst: jest.fn().mockResolvedValue({ id: 'approved-application' }) },
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
    expect(overview.eligible).toBe(true);
  });

  it('does not create or expose a referral link until the customer has an approved loan application', async () => {
    const findUnique = jest.fn().mockResolvedValue({ referralCode: null });
    const updateMany = jest.fn();
    const findFirst = jest.fn().mockResolvedValue(null);
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new ReferralService({
      user: { findUnique, updateMany },
      loanApplication: { findFirst },
      referral: { findMany },
    } as unknown as PrismaService);

    const overview = await service.getCustomerOverview('referrer-id');

    expect(overview).toMatchObject({ eligible: false, referralCode: null, referralLink: null, total: 0 });
    expect(updateMany).not.toHaveBeenCalled();
    expect(findFirst).toHaveBeenCalledWith({
      where: { userId: 'referrer-id', status: { in: ['APPROVED', 'ACCEPTED'] } },
      select: { id: true },
    });
  });
});
