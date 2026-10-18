import type { SystemIncident } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { MailService } from '../auth/mail.service';
import { SystemHealthService } from './system-health.service';

describe('SystemHealthService', () => {
  const environmentKeys = [
    'MPESA_ENVIRONMENT',
    'MPESA_SHORT_CODE',
    'MPESA_PASSKEY',
    'MPESA_CONSUMER_KEY',
    'MPESA_CONSUMER_SECRET',
    'MPESA_LIVE_ENABLED',
    'MPESA_TRANSACTION_TYPE',
    'MPESA_TILL_NUMBER',
    'MPESA_CALLBACK_URL',
    'RESEND_API_KEY',
    'RESEND_FROM',
  ];

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reports database outages without claiming that observations were persisted', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockRejectedValue(new Error('database unavailable')),
      $transaction: jest.fn().mockRejectedValue(new Error('database unavailable')),
    };
    const service = new SystemHealthService(
      prisma as unknown as PrismaService,
      {} as MailService,
    );

    const result = await service.runChecks('admin-id');

    expect(result.persisted).toBe(false);
    expect(result.components.find((check) => check.component === 'postgresql')).toMatchObject({
      status: 'DOWN',
      explanation: expect.stringContaining('connectivity check failed'),
    });
    expect(result.components.find((check) => check.component === 'payment_reconciliation')).toMatchObject({
      status: 'UNKNOWN',
    });
    expect(result.persistenceMessage).toContain('could not be persisted');
  });

  it('bounds database readiness probes and reports a timeout rather than hanging', async () => {
    jest.useFakeTimers();
    const prisma = {
      $queryRaw: jest.fn(() => new Promise<never>(() => undefined)),
      $transaction: jest.fn().mockRejectedValue(new Error('database unavailable')),
    };
    const service = new SystemHealthService(prisma as unknown as PrismaService, {} as MailService);

    try {
      const pending = service.runChecks('admin-id');
      await jest.advanceTimersByTimeAsync(3_000);
      const result = await pending;
      expect(result.components.find((check) => check.component === 'postgresql')?.explanation)
        .toContain('exceeded its 3000 ms timeout');
      expect(result.persisted).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('persists observed component checks and never contacts M-Pesa or email providers', async () => {
    const savedEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
    for (const key of environmentKeys) delete process.env[key];

    const incident: Partial<SystemIncident> = {
      id: 'incident-id',
      fingerprint: 'mpesa_configuration:MPESA_CONFIGURATION_INCOMPLETE',
      title: 'M-Pesa collection configuration incomplete',
      component: 'mpesa_configuration',
      category: 'MPESA_CONFIGURATION_INCOMPLETE',
      severity: 'WARNING',
      status: 'OPEN',
      description: 'M-Pesa settings are incomplete.',
      occurrenceCount: 1,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      recoveredAt: null,
      recoveryEvidence: null,
      acknowledgedAt: null,
      acknowledgedById: null,
      affectedModules: [],
      diagnosticEvidence: {},
    };
    const transactionClient = {
      systemHealthComponent: { upsert: jest.fn().mockResolvedValue({}) },
      systemIncident: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue(incident),
        update: jest.fn().mockResolvedValue(incident),
      },
      adminAuditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
      $transaction: jest.fn(async (callback: (tx: typeof transactionClient) => Promise<unknown>) => callback(transactionClient)),
      systemIncident: { findMany: jest.fn().mockResolvedValue([]) },
      paymentTransaction: { count: jest.fn().mockResolvedValue(0) },
      paymentReconciliationAttempt: { count: jest.fn().mockResolvedValue(0) },
      ledgerAccount: { findUnique: jest.fn().mockResolvedValue(null) },
      systemSetting: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const mail = { sendSystemIncidentAlert: jest.fn() };
    const fetchSpy = jest.spyOn(global, 'fetch');
    const service = new SystemHealthService(prisma as unknown as PrismaService, mail as unknown as MailService);

    try {
      const result = await service.runChecks('admin-id');
      const mpesa = result.components.find((check) => check.component === 'mpesa_configuration');

      expect(result.persisted).toBe(true);
      expect(mpesa?.status).toBe('DEGRADED');
      expect(mpesa?.explanation).toContain('No provider request was made');
      expect(transactionClient.systemHealthComponent.upsert).toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mail.sendSystemIncidentAlert).not.toHaveBeenCalled();
    } finally {
      for (const [key, value] of savedEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('retries failed high-priority alerts only after the cooldown and within the attempt limit', async () => {
    const originalApiKey = process.env.RESEND_API_KEY;
    const originalFrom = process.env.RESEND_FROM;
    process.env.RESEND_API_KEY = 'test-api-key';
    process.env.RESEND_FROM = 'LoanPlus <alerts@example.invalid>';
    jest.useFakeTimers({ now: new Date('2026-10-18T21:00:00.000Z') });

    const incident = {
      id: 'critical-incident',
      severity: 'CRITICAL',
      title: 'Database connectivity unavailable',
      description: 'The read-only database connectivity probe failed.',
      component: 'postgresql',
      category: 'DATABASE_CONNECTIVITY',
      firstSeenAt: new Date('2026-10-18T21:00:00.000Z'),
      lastSeenAt: new Date('2026-10-18T21:00:00.000Z'),
      status: 'OPEN',
      fingerprint: 'postgresql:DATABASE_CONNECTIVITY',
      occurrenceCount: 1,
      affectedModules: [],
      diagnosticEvidence: {},
      recoveredAt: null,
      recoveryEvidence: null,
      acknowledgedAt: null,
      acknowledgedById: null,
    } as SystemIncident;
    const createMany = jest.fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValue({ count: 0 });
    const updateMany = jest.fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const alertUpdate = jest.fn().mockResolvedValue({});
    const mail = {
      sendSystemIncidentAlert: jest.fn()
        .mockRejectedValueOnce(new Error('provider unavailable'))
        .mockResolvedValue(undefined),
    };
    const prisma = {
      systemIncidentAlert: { createMany, updateMany, update: alertUpdate },
      superadminUser: { findMany: jest.fn().mockResolvedValue([{ email: 'admin@example.invalid' }]) },
    };
    const service = new SystemHealthService(prisma as unknown as PrismaService, mail as unknown as MailService);
    const deliver = (service as unknown as {
      deliverAlert: (value: SystemIncident) => Promise<void>;
    }).deliverAlert;

    try {
      await deliver.call(service, incident);
      expect(alertUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED', failureCategory: 'EMAIL_DELIVERY_FAILED' }),
      }));

      jest.advanceTimersByTime(5 * 60_000);
      await deliver.call(service, incident);
      expect(alertUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: 'SENT', deliveredCount: 1 }),
      }));
      expect(updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
        where: expect.objectContaining({
          attemptCount: { lt: 3 },
          status: { in: ['FAILED', 'PARTIAL', 'UNAVAILABLE', 'STARTED'] },
        }),
      }));

      jest.advanceTimersByTime(5 * 60_000);
      await deliver.call(service, incident);
      expect(mail.sendSystemIncidentAlert).toHaveBeenCalledTimes(2);
      expect(updateMany).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
      if (originalApiKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = originalApiKey;
      if (originalFrom === undefined) delete process.env.RESEND_FROM;
      else process.env.RESEND_FROM = originalFrom;
    }
  });

  it('reclaims an abandoned STARTED alert only after its lease cooldown', async () => {
    const originalApiKey = process.env.RESEND_API_KEY;
    const originalFrom = process.env.RESEND_FROM;
    process.env.RESEND_API_KEY = 'test-api-key';
    process.env.RESEND_FROM = 'LoanPlus <alerts@example.invalid>';
    jest.useFakeTimers({ now: new Date('2026-10-18T21:00:00.000Z') });
    const incident = {
      id: 'abandoned-incident',
      severity: 'CRITICAL',
      title: 'Database connectivity unavailable',
      description: 'The database probe failed.',
      component: 'postgresql',
      category: 'DATABASE_CONNECTIVITY',
    } as SystemIncident;
    const claimStartedAt = Date.now();
    const updateMany = jest.fn(({ where }: { where: { attemptedAt: { lte: Date } } }) =>
      Promise.resolve({ count: where.attemptedAt.lte.getTime() >= claimStartedAt ? 1 : 0 }));
    const alertUpdate = jest.fn().mockResolvedValue({});
    const mail = { sendSystemIncidentAlert: jest.fn().mockResolvedValue(undefined) };
    const prisma = {
      systemIncidentAlert: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        updateMany,
        update: alertUpdate,
      },
      superadminUser: { findMany: jest.fn().mockResolvedValue([{ email: 'admin@example.invalid' }]) },
    };
    const service = new SystemHealthService(prisma as unknown as PrismaService, mail as unknown as MailService);
    const deliver = (service as unknown as {
      deliverAlert: (value: SystemIncident) => Promise<void>;
    }).deliverAlert;

    try {
      await deliver.call(service, incident);
      expect(updateMany).toHaveBeenCalledTimes(1);
      expect(mail.sendSystemIncidentAlert).not.toHaveBeenCalled();

      jest.advanceTimersByTime(5 * 60_000);
      await deliver.call(service, incident);

      expect(updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
        where: expect.objectContaining({
          incidentId: incident.id,
          status: { in: ['FAILED', 'PARTIAL', 'UNAVAILABLE', 'STARTED'] },
          attemptCount: { lt: 3 },
        }),
      }));
      expect(mail.sendSystemIncidentAlert).toHaveBeenCalledTimes(1);
      expect(alertUpdate).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: 'SENT', deliveredCount: 1 }),
      }));
    } finally {
      jest.useRealTimers();
      if (originalApiKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = originalApiKey;
      if (originalFrom === undefined) delete process.env.RESEND_FROM;
      else process.env.RESEND_FROM = originalFrom;
    }
  });
});
