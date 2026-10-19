import { BadRequestException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AdminController } from './admin.controller';
import type { AdminService } from './admin.service';
import type { AuthenticatedRequest } from '../auth/request.types';
import type { AuthService } from '../auth/auth.service';
import { SuperadminSessionGuard } from '../auth/session.guard';

describe('AdminController listing filters', () => {
  const admin = {
    listCustomers: jest.fn(),
    listPayments: jest.fn(),
    getCustomerDetails: jest.fn(),
    updateCustomerStatus: jest.fn(),
    updateCustomerIdentityStatus: jest.fn(),
    updateCustomerProfile: jest.fn(),
    getAuditEvents: jest.fn(),
  };
  const auth = { requestCustomerPasswordReset: jest.fn() };
  const controller = new AdminController(admin as unknown as AdminService, auth as unknown as AuthService);

  beforeEach(() => jest.clearAllMocks());

  it('protects customer identity decisions with the verified Superadmin session role', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, AdminController) as unknown[];
    expect(guards).toContain(SuperadminSessionGuard);
  });

  it('validates and forwards customer filters and pagination', async () => {
    admin.listCustomers.mockResolvedValue({ items: [], total: 0 });

    await controller.listCustomers('LP1', '2', '20', 'ACTIVE', 'VERIFIED', '2026-01-01', '2026-01-31');

    expect(admin.listCustomers).toHaveBeenCalledWith(expect.objectContaining({
      search: 'LP1',
      page: 2,
      pageSize: 20,
      accountStatus: 'ACTIVE',
      identityStatus: 'VERIFIED',
      registeredFrom: new Date('2025-12-31T21:00:00.000Z'),
      registeredTo: new Date('2026-01-31T20:59:59.999Z'),
    }));
  });

  it('rejects invalid customer page and reversed date ranges', async () => {
    await expect(controller.listCustomers(undefined, '0')).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.listCustomers(undefined, undefined, undefined, undefined, undefined, '2026-02-01', '2026-01-01'))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('validates and forwards payment type, status, date range, and pagination', async () => {
    admin.listPayments.mockResolvedValue({ items: [], total: 0 });

    await controller.listPayments('LPA', 'PENDING', 'ACTIVATION', '3', '10', '2026-02-01', '2026-02-02');

    expect(admin.listPayments).toHaveBeenCalledWith(expect.objectContaining({
      search: 'LPA',
      status: 'PENDING',
      type: 'ACTIVATION',
      page: 3,
      pageSize: 10,
      from: new Date('2026-01-31T21:00:00.000Z'),
      to: new Date('2026-02-02T20:59:59.999Z'),
    }));
  });

  it('rejects unsupported payment filters and invalid ranges', async () => {
    await expect(controller.listPayments(undefined, undefined, 'INVALID')).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.listPayments(undefined, undefined, undefined, undefined, undefined, '2026-03-01', '2026-02-01'))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('passes the authenticated administrator and request IP to the audited status action', async () => {
    admin.updateCustomerStatus.mockResolvedValue({ id: 'customer-id', isActive: false, changed: true });
    const request = { principal: { id: 'admin-id' }, ip: '127.0.0.1' } as unknown as AuthenticatedRequest;

    await controller.updateCustomerStatus('customer-id', { isActive: false, reason: 'Confirmed support request' }, request);

    expect(admin.updateCustomerStatus).toHaveBeenCalledWith(
      'customer-id',
      false,
      'Confirmed support request',
      'admin-id',
      '127.0.0.1',
    );
  });

  it('forwards identity decisions only with the authenticated Admin actor and review confirmation', async () => {
    admin.updateCustomerIdentityStatus.mockResolvedValue({
      id: 'customer-id',
      identityStatus: 'VERIFIED',
      changed: true,
    });
    const request = { principal: { id: 'superadmin-id', role: 'SUPERADMIN' }, ip: '127.0.0.1' } as unknown as AuthenticatedRequest;

    await controller.updateCustomerIdentityStatus('customer-id', {
      status: 'VERIFIED',
      reason: 'Reviewed approved identity evidence',
      reviewConfirmed: true,
    }, request);

    expect(admin.updateCustomerIdentityStatus).toHaveBeenCalledWith(
      'customer-id',
      'VERIFIED',
      'Reviewed approved identity evidence',
      true,
      'superadmin-id',
      '127.0.0.1',
    );
  });

  it('forwards the profile change with its concurrency version and authenticated actor', async () => {
    admin.updateCustomerProfile.mockResolvedValue({ id: 'customer-id', fullName: 'Amina Otieno', changed: true });
    const request = { principal: { id: 'admin-id' }, ip: '127.0.0.1' } as unknown as AuthenticatedRequest;

    await controller.updateCustomerProfile('customer-id', {
      fullName: 'Amina Otieno',
      expectedUpdatedAt: '2026-10-18T20:00:00.000Z',
      reason: 'Customer requested a display name correction',
    }, request);

    expect(admin.updateCustomerProfile).toHaveBeenCalledWith(
      'customer-id',
      'Amina Otieno',
      '2026-10-18T20:00:00.000Z',
      'Customer requested a display name correction',
      'admin-id',
      '127.0.0.1',
    );
  });

  it('uses the authenticated Admin for a reason-required reset request', async () => {
    auth.requestCustomerPasswordReset.mockResolvedValue({ requested: true, delivery: 'SENT' });
    const request = { principal: { id: 'admin-id' }, ip: '127.0.0.1' } as unknown as AuthenticatedRequest;

    await controller.requestCustomerPasswordReset('customer-id', {
      reason: 'Customer requested password reset support',
    }, request);

    expect(auth.requestCustomerPasswordReset).toHaveBeenCalledWith(
      'customer-id',
      'admin-id',
      'Customer requested password reset support',
      '127.0.0.1',
    );
  });

  it('validates and forwards audit filters with bounded pagination', async () => {
    admin.getAuditEvents.mockResolvedValue({ items: [], total: 0 });
    await controller.getAudit(
      'profile',
      'admin-id',
      'CUSTOMER_PROFILE_UPDATED',
      'CUSTOMER',
      'SUCCESS',
      '2026-10-01',
      '2026-10-18',
      '2',
      '25',
    );
    expect(admin.getAuditEvents).toHaveBeenCalledWith(expect.objectContaining({
      search: 'profile',
      actorId: 'admin-id',
      action: 'CUSTOMER_PROFILE_UPDATED',
      resourceType: 'CUSTOMER',
      outcome: 'SUCCESS',
      page: 2,
      pageSize: 25,
    }));
    await expect(controller.getAudit(undefined, undefined, undefined, undefined, undefined, '2026-10-20', '2026-10-01'))
      .rejects.toBeInstanceOf(BadRequestException);
  });
});
