import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { SupportTicketStatus } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSupportTicketDto, ReplySupportTicketDto } from './support.dto';

@Injectable()
export class SupportService {
  constructor(private readonly prisma: PrismaService) {}

  async createTicket(userId: string, dto: CreateSupportTicketDto) {
    const reference = `LPS${randomBytes(8).toString('hex').toUpperCase()}`;
    return this.prisma.supportTicket.create({
      data: {
        reference,
        userId,
        subject: dto.subject.trim(),
        messages: {
          create: {
            authorType: 'CUSTOMER',
            authorId: userId,
            message: dto.message.trim(),
          },
        },
      },
      select: { id: true, reference: true, subject: true, status: true, createdAt: true },
    });
  }

  listCustomerTickets(userId: string) {
    return this.prisma.supportTicket.findMany({
      where: { userId },
      select: {
        id: true,
        reference: true,
        subject: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        messages: { select: { id: true, authorType: true, message: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  listTicketsForAdmin() {
    return this.prisma.supportTicket.findMany({
      include: {
        user: { select: { id: true, fullName: true, email: true } },
        messages: { orderBy: { createdAt: 'asc' } },
      },
      orderBy: [{ status: 'asc' }, { updatedAt: 'asc' }],
      take: 500,
    });
  }

  async replyToTicket(ticketId: string, dto: ReplySupportTicketDto, adminId: string, ipAddress?: string) {
    const ticket = await this.prisma.supportTicket.findUnique({ where: { id: ticketId }, select: { id: true } });
    if (!ticket) throw new NotFoundException('Support ticket was not found.');
    const transitionAllowed = dto.status !== SupportTicketStatus.OPEN;
    if (!transitionAllowed) throw new ConflictException('A replied ticket cannot be reopened through this action.');
    return this.prisma.$transaction(async (tx) => {
      await tx.supportMessage.create({
        data: { ticketId, authorType: 'SUPERADMIN', authorId: adminId, message: dto.message.trim() },
      });
      const updated = await tx.supportTicket.update({
        where: { id: ticketId },
        data: { status: dto.status },
        select: { id: true, reference: true, status: true, updatedAt: true },
      });
      await tx.adminAuditLog.create({
        data: { superadminId: adminId, action: 'SUPPORT_TICKET_REPLY', subjectType: 'SUPPORT_TICKET', subjectId: ticketId, outcome: 'SUCCESS', ipAddress: ipAddress?.slice(0, 64) },
      });
      return updated;
    });
  }
}