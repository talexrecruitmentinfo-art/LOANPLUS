import { PrismaService } from '../prisma/prisma.service';
import { SupportService } from './support.service';
import { ReplySupportTicketDto, CreateSupportTicketDto } from './support.dto';
import { randomBytes } from 'node:crypto';

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseTest = databaseUrl ? it : it.skip;

describe('support database integration', () => {
  let prisma: PrismaService;
  let support: SupportService;
  let userId: string;
  let otherUserId: string;
  let adminId: string;
  let ticketId: string;

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    const parsedUrl = new URL(databaseUrl);
    if (!['localhost', '127.0.0.1', '::1'].includes(parsedUrl.hostname) || !parsedUrl.pathname.endsWith('_test')) {
      throw new Error('TEST_DATABASE_URL must point to a local database whose name ends in _test.');
    }
    prisma = new PrismaService();
    await prisma.$connect();
    support = new SupportService(prisma);
    const suffix = `${Date.now()}-${randomBytes(4).toString('hex')}`;
    const users = await prisma.user.createMany({
      data: [1, 2].map((index) => ({
        fullName: `Support Test Customer ${index}`,
        email: `support-${suffix}-${index}@example.invalid`,
        phone: `+2547${index.toString().padStart(8, '0')}`,
        nationalIdCiphertext: 'test-fixture-only',
        nationalIdHash: randomBytes(32).toString('hex'),
        passwordHash: 'test-fixture-only',
        termsVersion: 'test-v1',
        privacyVersion: 'test-v1',
      })),
    });
    if (users.count !== 2) throw new Error('Could not create support test customers.');
    const createdUsers = await prisma.user.findMany({ where: { email: { startsWith: `support-${suffix}-` } }, select: { id: true }, orderBy: { email: 'asc' } });
    userId = createdUsers[0].id;
    otherUserId = createdUsers[1].id;
    const admin = await prisma.superadminUser.create({
      data: {
        email: `support-admin-${suffix}@example.invalid`,
        passwordHash: 'test-fixture-only',
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });
    adminId = admin.id;
  });

  afterAll(async () => {
    if (!databaseUrl || !prisma) return;
    if (ticketId) await prisma.supportMessage.deleteMany({ where: { ticketId } });
    await prisma.supportTicket.deleteMany({ where: { userId: { in: [userId, otherUserId].filter(Boolean) } } });
    await prisma.adminAuditLog.deleteMany({ where: { superadminId: adminId } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId].filter(Boolean) } } });
    await prisma.superadminUser.deleteMany({ where: { id: adminId } });
    await prisma.$disconnect();
  });

  databaseTest('isolates customer ticket history and audits Superadmin replies', async () => {
    const dto = Object.assign(new CreateSupportTicketDto(), {
      subject: 'Question about my account',
      message: 'Please explain the account status shown on my dashboard.',
    });
    const created = await support.createTicket(userId, dto);
    ticketId = created.id;
    expect(created.reference).toMatch(/^LPS[A-F0-9]{16}$/);
    expect(await support.listCustomerTickets(otherUserId)).toHaveLength(0);
    expect(await support.listCustomerTickets(userId)).toHaveLength(1);
    expect(await support.listTicketsForAdmin()).toHaveLength(1);

    const reply = Object.assign(new ReplySupportTicketDto(), {
      message: 'Your account status is visible in your account overview.',
      status: 'WAITING_FOR_CUSTOMER',
    });
    const updated = await support.replyToTicket(ticketId, reply, adminId, '127.0.0.1');
    expect(updated.status).toBe('WAITING_FOR_CUSTOMER');
    expect(await prisma.supportMessage.count({ where: { ticketId } })).toBe(2);
    expect(await prisma.adminAuditLog.count({ where: { superadminId: adminId, action: 'SUPPORT_TICKET_REPLY' } })).toBe(1);
  });
});