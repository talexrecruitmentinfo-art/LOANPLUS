import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type SystemIncident } from '@prisma/client';
import { buildMpesaCallbackUrl } from '../payments/mpesa-callback-url';
import { getLoanProcessingFeePolicy } from '../payments/processing-fee.constants';
import { MailService } from '../auth/mail.service';
import { PrismaService } from '../prisma/prisma.service';

const STALE_AFTER_MS = 5 * 60_000;
const DATABASE_PROBE_TIMEOUT_MS = 3_000;
const AGED_PAYMENT_AFTER_MS = 15 * 60_000;
const ALERT_RETRY_COOLDOWN_MS = 5 * 60_000;
const MAX_ALERT_ATTEMPTS = 3;
const logger = new Logger('AdminSystemHealthService');

export interface HealthAffectedModule {
  name: string;
  impact: 'CONFIRMED' | 'POTENTIAL';
  evidence: string;
}

interface HealthIncidentSignal {
  category: string;
  title: string;
  severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
  description: string;
  diagnosticEvidence: Prisma.InputJsonValue;
}

export interface SystemHealthCheck {
  component: string;
  status: 'HEALTHY' | 'DEGRADED' | 'DOWN' | 'UNKNOWN';
  explanation: string;
  checkedAt: string;
  durationMs: number | null;
  lastSuccessAt: string | null;
  stale: boolean;
  affectedModules: HealthAffectedModule[];
  recommendedAction: string;
  incident?: HealthIncidentSignal;
  recoveryEvidence?: string;
}

@Injectable()
export class SystemHealthService {
  constructor(private readonly prisma: PrismaService, private readonly mail: MailService) {}

  async getDashboard(options: {
    search?: string;
    severity?: string;
    status?: string;
    page: number;
    pageSize: number;
  }) {
    const incidentFilters: Prisma.SystemIncidentWhereInput[] = [];
    const query = options.search?.trim().slice(0, 100);
    if (query) {
      incidentFilters.push({
        OR: [
          { title: { contains: query, mode: 'insensitive' } },
          { component: { contains: query, mode: 'insensitive' } },
          { category: { contains: query, mode: 'insensitive' } },
          { description: { contains: query, mode: 'insensitive' } },
        ],
      });
    }
    if (options.severity) incidentFilters.push({ severity: options.severity });
    if (options.status) incidentFilters.push({ status: options.status });
    const incidentWhere: Prisma.SystemIncidentWhereInput = incidentFilters.length ? { AND: incidentFilters } : {};
    const [components, incidents, incidentTotal, activeIncidents, criticalIncidents] = await Promise.all([
      this.prisma.systemHealthComponent.findMany({ orderBy: { component: 'asc' } }),
      this.prisma.systemIncident.findMany({
        where: incidentWhere,
        orderBy: [{ lastSeenAt: 'desc' }, { id: 'desc' }],
        skip: (options.page - 1) * options.pageSize,
        take: options.pageSize,
        include: {
          notes: { orderBy: { createdAt: 'desc' }, take: 10 },
          alert: {
            select: {
              channel: true,
              status: true,
              failureCategory: true,
              recipientCount: true,
              deliveredCount: true,
              attemptCount: true,
              attemptedAt: true,
              completedAt: true,
            },
          },
        },
      }),
      this.prisma.systemIncident.count({ where: incidentWhere }),
      this.prisma.systemIncident.count({ where: { status: { in: ['OPEN', 'ACKNOWLEDGED'] } } }),
      this.prisma.systemIncident.count({ where: { status: { in: ['OPEN', 'ACKNOWLEDGED'] }, severity: 'CRITICAL' } }),
    ]);
    const now = Date.now();
    const checks = components.map((component) => ({
      component: component.component,
      status: component.status as SystemHealthCheck['status'],
      explanation: component.explanation,
      checkedAt: component.checkedAt.toISOString(),
      durationMs: component.durationMs,
      lastSuccessAt: component.lastSuccessAt?.toISOString() ?? null,
      stale: now - component.checkedAt.getTime() > STALE_AFTER_MS,
      affectedModules: this.readAffectedModules(component.affectedModules),
      recommendedAction: component.recommendedAction,
    }));
    return {
      checkedAt: checks.reduce<string | null>(
        (latest, check) => !latest || check.checkedAt > latest ? check.checkedAt : latest,
        null,
      ),
      staleAfterSeconds: STALE_AFTER_MS / 1000,
      components: checks,
      incidents,
      incidentPagination: {
        total: incidentTotal,
        page: options.page,
        pageSize: options.pageSize,
        pageCount: Math.ceil(incidentTotal / options.pageSize),
      },
      metrics: {
        overallStatus: this.getOverallStatus(checks),
        activeIncidents,
        criticalIncidents,
        unresolvedPaymentExceptions: this.getUnresolvedPaymentCount(checks),
      },
      alertDelivery: {
        configured: this.isEmailConfigured(),
        provider: 'Resend',
        explanation: this.isEmailConfigured()
          ? 'Email configuration is present; this dashboard does not probe the provider.'
          : 'Resend alert delivery is unavailable: RESEND_API_KEY or a valid RESEND_FROM is missing.',
      },
    };
  }

  async runChecks(actorId: string, ipAddress?: string) {
    const checks = await this.collectChecks();
    let persisted = true;
    try {
      const incidentActions = await this.prisma.$transaction(async (tx) => {
        const actions: SystemIncident[] = [];
        for (const check of checks) {
          const affectedModules = this.toJsonAffectedModules(check.affectedModules);
          await tx.systemHealthComponent.upsert({
            where: { component: check.component },
            create: {
              component: check.component,
              status: check.status,
              explanation: check.explanation,
              checkedAt: new Date(check.checkedAt),
              durationMs: check.durationMs,
              lastSuccessAt: check.status === 'HEALTHY' ? new Date(check.checkedAt) : null,
              affectedModules,
              recommendedAction: check.recommendedAction,
            },
            update: {
              status: check.status,
              explanation: check.explanation,
              checkedAt: new Date(check.checkedAt),
              durationMs: check.durationMs,
              ...(check.status === 'HEALTHY' ? { lastSuccessAt: new Date(check.checkedAt) } : {}),
              affectedModules,
              recommendedAction: check.recommendedAction,
            },
          });

          if (check.incident) {
            const result = await this.upsertIncident(tx, { ...check, incident: check.incident });
            actions.push(result);
          } else if (check.recoveryEvidence) {
            await this.recoverComponentIncidents(tx, check);
          }
        }
        await tx.adminAuditLog.create({
          data: {
            superadminId: actorId,
            action: 'SYSTEM_HEALTH_CHECK',
            subjectType: 'SYSTEM_HEALTH',
            subjectId: 'components',
            outcome: 'SUCCESS',
            reason: 'Superadmin requested an on-demand system health check.',
            ipAddress: ipAddress?.slice(0, 64),
          },
        });
        return actions;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      for (const incident of incidentActions) await this.deliverAlert(incident);
    } catch (error) {
      persisted = false;
      const errorCategory = error instanceof Prisma.PrismaClientKnownRequestError
        ? `PRISMA_${error.code}`
        : error instanceof Prisma.PrismaClientInitializationError
          ? 'DATABASE_INITIALIZATION_FAILED'
          : 'HEALTH_RECORD_PERSISTENCE_FAILED';
      const errorType = error instanceof Error ? error.name : typeof error;
      logger.warn(`Health check results could not be persisted (${errorCategory}; ${errorType}).`);
    }
    const incidents = persisted
      ? await this.prisma.systemIncident.findMany({
          where: { status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
          orderBy: { lastSeenAt: 'desc' },
          take: 100,
          include: { notes: { orderBy: { createdAt: 'desc' }, take: 10 }, alert: true },
        })
      : [];
    return {
      checkedAt: new Date().toISOString(),
      persisted,
      persistenceMessage: persisted
        ? 'Health observations and incident changes were persisted.'
        : 'Health observations were measured but could not be persisted. Database monitoring history is incomplete.',
      components: checks.map(({ incident: _incident, recoveryEvidence: _recovery, ...check }) => check),
      incidents,
    };
  }

  async addIncidentNote(incidentId: string, actorId: string, note: string, ipAddress?: string) {
    const safeNote = note.trim();
    if (safeNote.length < 10 || safeNote.length > 1000) {
      throw new BadRequestException('An incident note between 10 and 1000 characters is required.');
    }
    return this.prisma.$transaction(async (tx) => {
      const incident = await tx.systemIncident.findUnique({ where: { id: incidentId }, select: { id: true } });
      if (!incident) throw new NotFoundException('System incident was not found.');
      const created = await tx.systemIncidentNote.create({
        data: { incidentId, actorId, note: safeNote },
      });
      await tx.adminAuditLog.create({
        data: {
          superadminId: actorId,
          action: 'SYSTEM_INCIDENT_NOTE_ADDED',
          subjectType: 'SYSTEM_INCIDENT',
          subjectId: incidentId,
          outcome: 'SUCCESS',
          reason: safeNote.slice(0, 500),
          ipAddress: ipAddress?.slice(0, 64),
        },
      });
      return created;
    });
  }

  async acknowledgeIncident(incidentId: string, actorId: string, reason: string, ipAddress?: string) {
    const safeReason = reason.trim();
    if (safeReason.length < 10 || safeReason.length > 500) {
      throw new BadRequestException('An acknowledgement reason between 10 and 500 characters is required.');
    }
    return this.prisma.$transaction(async (tx) => {
      const incident = await tx.systemIncident.findUnique({ where: { id: incidentId } });
      if (!incident) throw new NotFoundException('System incident was not found.');
      if (incident.status === 'RESOLVED') throw new BadRequestException('A recovered incident cannot be acknowledged as active.');
      const updated = await tx.systemIncident.update({
        where: { id: incidentId },
        data: { status: 'ACKNOWLEDGED', acknowledgedAt: new Date(), acknowledgedById: actorId },
      });
      await tx.adminAuditLog.create({
        data: {
          superadminId: actorId,
          action: 'SYSTEM_INCIDENT_ACKNOWLEDGED',
          subjectType: 'SYSTEM_INCIDENT',
          subjectId: incidentId,
          outcome: 'SUCCESS',
          reason: safeReason,
          ipAddress: ipAddress?.slice(0, 64),
        },
      });
      return updated;
    });
  }

  private async collectChecks(): Promise<SystemHealthCheck[]> {
    const now = new Date();
    const checks: SystemHealthCheck[] = [];
    const apiStarted = Date.now();
    checks.push({
      component: 'api_process',
      status: 'HEALTHY',
      explanation: 'The API process is responding to the authenticated health-check request.',
      checkedAt: now.toISOString(),
      durationMs: Date.now() - apiStarted,
      lastSuccessAt: now.toISOString(),
      stale: false,
      affectedModules: [],
      recommendedAction: 'No action required. Check again if this observation becomes stale.',
      recoveryEvidence: 'Authenticated health endpoint responded successfully.',
    });

    const dbStarted = Date.now();
    let databaseAvailable = false;
    let databaseProbeTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.prisma.$queryRaw`SELECT 1`,
        new Promise<never>((_, reject) => {
          databaseProbeTimer = setTimeout(() => reject(new Error('DATABASE_PROBE_TIMEOUT')), DATABASE_PROBE_TIMEOUT_MS);
        }),
      ]);
      databaseAvailable = true;
      checks.push({
        component: 'postgresql',
        status: 'HEALTHY',
        explanation: 'PostgreSQL accepted a minimal read-only SELECT 1 query.',
        checkedAt: now.toISOString(),
        durationMs: Date.now() - dbStarted,
        lastSuccessAt: now.toISOString(),
        stale: false,
        affectedModules: [],
        recommendedAction: 'No action required. This check does not measure database load or pool saturation.',
        recoveryEvidence: 'Read-only SELECT 1 completed successfully.',
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.message === 'DATABASE_PROBE_TIMEOUT';
      checks.push({
        component: 'postgresql',
        status: 'DOWN',
        explanation: timedOut
          ? `The read-only database connectivity check exceeded its ${DATABASE_PROBE_TIMEOUT_MS} ms timeout; diagnostic details are suppressed.`
          : 'The database connectivity check failed; diagnostic details are intentionally suppressed.',
        checkedAt: now.toISOString(),
        durationMs: Date.now() - dbStarted,
        lastSuccessAt: null,
        stale: false,
        affectedModules: [
          { name: 'Customer authentication and records', impact: 'POTENTIAL', evidence: 'Customer sessions and account records are stored in PostgreSQL.' },
          { name: 'Loan applications and decisions', impact: 'POTENTIAL', evidence: 'Applications, loans, and repayment schedules are stored in PostgreSQL.' },
          { name: 'Payment and ledger history', impact: 'POTENTIAL', evidence: 'Payment and ledger records are stored in PostgreSQL.' },
          { name: 'Admin operations', impact: 'POTENTIAL', evidence: 'Admin data and audit records are stored in PostgreSQL.' },
        ],
        recommendedAction: 'Check database availability and connection-pool health. Do not retry financial operations until the database is available.',
        incident: {
          category: 'DATABASE_CONNECTIVITY',
          title: 'Database connectivity unavailable',
          severity: 'CRITICAL',
          description: 'The read-only database connectivity probe failed. Database-backed user and financial operations may be unavailable.',
          diagnosticEvidence: { probe: 'SELECT 1', outcome: 'FAILED' },
        },
      });
    } finally {
      if (databaseProbeTimer) clearTimeout(databaseProbeTimer);
    }

    checks.push(this.checkMpesaConfiguration(now));
    checks.push(this.checkEmailConfiguration(now));
    checks.push({
      component: 'background_jobs',
      status: 'UNKNOWN',
      explanation: 'No worker or scheduler mechanism is registered in this application; job execution is not observable.',
      checkedAt: now.toISOString(),
      durationMs: null,
      lastSuccessAt: null,
      stale: false,
      affectedModules: [],
      recommendedAction: 'Add an explicitly managed worker and heartbeat before claiming background-job health.',
    });
    checks.push({
      component: 'website_publishing',
      status: 'UNKNOWN',
      explanation: 'Website publishing is request-driven; no independent availability probe or publication monitor is configured.',
      checkedAt: now.toISOString(),
      durationMs: null,
      lastSuccessAt: null,
      stale: false,
      affectedModules: [],
      recommendedAction: 'Inspect the website publication endpoint and revision history when a publishing error is reported.',
    });

    if (databaseAvailable) {
      checks.push(await this.checkReconciliationQueue(now));
      checks.push(await this.checkFinancialConfiguration(now));
    } else {
      for (const component of ['payment_reconciliation', 'financial_configuration']) {
        checks.push({
          component,
          status: 'UNKNOWN',
          explanation: 'This database-backed component could not be checked while database connectivity was unavailable.',
          checkedAt: now.toISOString(),
          durationMs: null,
          lastSuccessAt: null,
          stale: false,
          affectedModules: [],
          recommendedAction: 'Restore database connectivity and rerun the health check.',
        });
      }
    }
    return checks;
  }

  private checkMpesaConfiguration(checkedAt: Date): SystemHealthCheck {
    const started = Date.now();
    const required = ['MPESA_ENVIRONMENT', 'MPESA_SHORT_CODE', 'MPESA_PASSKEY', 'MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET'];
    const missing = required.filter((name) => !process.env[name]?.trim() || process.env[name]?.startsWith('replace-with-'));
    const environment = process.env.MPESA_ENVIRONMENT;
    if (environment !== 'sandbox' && environment !== 'production') missing.push('MPESA_ENVIRONMENT');
    if (environment === 'production' && process.env.MPESA_LIVE_ENABLED !== 'true') missing.push('MPESA_LIVE_ENABLED');
    const transactionType = process.env.MPESA_TRANSACTION_TYPE ?? (environment === 'sandbox' ? 'CustomerPayBillOnline' : undefined);
    if (transactionType !== 'CustomerPayBillOnline' && transactionType !== 'CustomerBuyGoodsOnline') missing.push('MPESA_TRANSACTION_TYPE');
    if (transactionType === 'CustomerBuyGoodsOnline' && !process.env.MPESA_TILL_NUMBER?.trim()) missing.push('MPESA_TILL_NUMBER');
    try {
      buildMpesaCallbackUrl('healthchecktoken');
    } catch {
      missing.push('MPESA_CALLBACK_URL');
    }
    const uniqueMissing = [...new Set(missing)];
    if (uniqueMissing.length) {
      return {
        component: 'mpesa_configuration',
        status: 'DEGRADED',
        explanation: `M-Pesa collection is not ready. Missing or invalid configuration: ${uniqueMissing.join(', ')}. No provider request was made.`,
        checkedAt: checkedAt.toISOString(),
        durationMs: Date.now() - started,
        lastSuccessAt: null,
        stale: false,
        affectedModules: [
          { name: 'M-Pesa collection initiation', impact: 'CONFIRMED', evidence: 'Required configuration checks failed without contacting the provider.' },
          { name: 'Payment confirmation callbacks', impact: 'POTENTIAL', evidence: 'The configured callback URL or collection configuration is incomplete.' },
        ],
        recommendedAction: 'Have the authorized operator verify the named environment configuration and callback routing; never paste credentials into this dashboard.',
        incident: {
          category: 'MPESA_CONFIGURATION_INCOMPLETE',
          title: 'M-Pesa collection configuration incomplete',
          severity: 'WARNING',
          description: `M-Pesa readiness validation found missing or invalid configuration names: ${uniqueMissing.join(', ')}. No credential values are recorded.`,
          diagnosticEvidence: { missingSettingNames: uniqueMissing, providerContacted: false },
        },
      };
    }
    return {
      component: 'mpesa_configuration',
      status: 'UNKNOWN',
      explanation: `Required M-Pesa ${environment} configuration and callback URL passed structural validation. Provider authentication and availability were not tested.`,
      checkedAt: checkedAt.toISOString(),
      durationMs: Date.now() - started,
      lastSuccessAt: null,
      stale: false,
      affectedModules: [],
      recommendedAction: 'Use the approved sandbox or operational provider monitor to verify availability; this check never sends a payment or OAuth request.',
      recoveryEvidence: 'Required setting names and callback URL passed structural validation; provider connectivity remains unverified.',
    };
  }

  private checkEmailConfiguration(checkedAt: Date): SystemHealthCheck {
    const configured = this.isEmailConfigured();
    return {
      component: 'email_delivery',
      status: configured ? 'UNKNOWN' : 'DEGRADED',
      explanation: configured
        ? 'Resend credentials and sender configuration are present. Delivery has not been tested by this health check.'
        : 'Email delivery is not configured with a valid Resend sender and API key.',
      checkedAt: checkedAt.toISOString(),
      durationMs: 0,
      lastSuccessAt: null,
      stale: false,
      affectedModules: configured ? [] : [
        { name: 'Password-reset delivery', impact: 'POTENTIAL', evidence: 'The existing password reset flow sends links using the shared Resend MailService.' },
        { name: 'Superadmin OTP delivery', impact: 'POTENTIAL', evidence: 'Administrator login OTP delivery uses the shared Resend MailService.' },
      ],
      recommendedAction: configured
        ? 'Review delivery-provider health separately; no email was sent during this check.'
        : 'Configure RESEND_API_KEY and a valid RESEND_FROM through the deployment secret manager.',
      ...(configured ? { recoveryEvidence: 'Required email configuration is present; actual delivery remains unverified.' } : {
        incident: {
          category: 'EMAIL_CONFIGURATION_MISSING',
          title: 'Email delivery configuration missing',
          severity: 'WARNING' as const,
          description: 'The required Resend settings are missing or the sender address is invalid. No secret values are recorded.',
          diagnosticEvidence: { provider: 'Resend', credentialsExposed: false },
        },
      }),
    };
  }

  private async checkReconciliationQueue(checkedAt: Date): Promise<SystemHealthCheck> {
    const started = Date.now();
    const cutoff = new Date(checkedAt.getTime() - AGED_PAYMENT_AFTER_MS);
    const [agedPending, legacy4999, unresolvedProviderAttempts] = await Promise.all([
      this.prisma.paymentTransaction.count({ where: { status: 'PENDING', createdAt: { lte: cutoff } } }),
      this.prisma.paymentTransaction.count({ where: { status: 'FAILED', failureCode: 'MPESA_RESULT_4999' } }),
      this.prisma.paymentReconciliationAttempt.count({
        where: { outcome: { in: ['UNRESOLVED_PROVIDER_UNAVAILABLE', 'UNRESOLVED_UNKNOWN_RESULT', 'UNRESOLVED_IDENTIFIER_MISMATCH', 'QUERY_ERROR'] } },
      }),
    ]);
    const count = agedPending + legacy4999 + unresolvedProviderAttempts;
    return {
      component: 'payment_reconciliation',
      status: count ? 'DEGRADED' : 'HEALTHY',
      explanation: count
        ? `${agedPending} aged pending, ${legacy4999} legacy 4999, and ${unresolvedProviderAttempts} unresolved provider-query records require review.`
        : 'No aged pending, legacy 4999, or unresolved provider-query records were found.',
      checkedAt: checkedAt.toISOString(),
      durationMs: Date.now() - started,
      lastSuccessAt: count ? null : checkedAt.toISOString(),
      stale: false,
      affectedModules: count ? [
        { name: 'Payment investigation queue', impact: 'CONFIRMED', evidence: `${count} supported unresolved records meet the reconciliation exception checks.` },
      ] : [],
      recommendedAction: count
        ? 'Review the protected reconciliation queue. Do not retry, settle, or change legacy 4999 records without verified provider evidence.'
        : 'No action required. New exceptions remain subject to the reconciliation policy.',
      ...(count ? {
        incident: {
          category: 'PAYMENT_RECONCILIATION_BACKLOG',
          title: 'Payment reconciliation exceptions require review',
          severity: 'WARNING' as const,
          description: `${count} unresolved payment exceptions are currently visible in the reconciliation queue.`,
          diagnosticEvidence: { agedPending, legacy4999, unresolvedProviderAttempts, ageThresholdMinutes: AGED_PAYMENT_AFTER_MS / 60_000 },
        },
      } : { recoveryEvidence: 'The aged-pending, legacy 4999, and provider-query exception counts returned to zero.' }),
    };
  }

  private async checkFinancialConfiguration(checkedAt: Date): Promise<SystemHealthCheck> {
    const started = Date.now();
    const [clearing, revenueSetting] = await Promise.all([
      this.prisma.ledgerAccount.findUnique({ where: { code: 'MPESA_CLEARING' }, select: { accountType: true, currency: true, isActive: true } }),
      this.prisma.systemSetting.findUnique({ where: { key: 'loan.processing_fee_revenue_account' }, select: { value: true } }),
    ]);
    const revenueCode = typeof revenueSetting?.value === 'string' ? revenueSetting.value : null;
    const revenue = revenueCode
      ? await this.prisma.ledgerAccount.findUnique({ where: { code: revenueCode }, select: { accountType: true, currency: true, isActive: true } })
      : null;
    const blockers: string[] = [];
    if (!clearing?.isActive || clearing.currency !== 'KES' || clearing.accountType !== 'ASSET') blockers.push('Active KES MPESA_CLEARING asset is not configured.');
    if (!revenueCode || !revenue?.isActive || revenue.currency !== 'KES' || revenue.accountType !== 'REVENUE') blockers.push('Active KES processing-fee revenue account is not configured.');
    if (getLoanProcessingFeePolicy().status !== 'CONFIGURED') blockers.push('Approved processing-fee policy is not configured.');
    return {
      component: 'financial_configuration',
      status: blockers.length ? 'DEGRADED' : 'HEALTHY',
      explanation: blockers.length ? blockers.join(' ') : 'Processing-fee policy and KES clearing/revenue account prerequisites are configured.',
      checkedAt: checkedAt.toISOString(),
      durationMs: Date.now() - started,
      lastSuccessAt: blockers.length ? null : checkedAt.toISOString(),
      stale: false,
      affectedModules: blockers.length ? [
        { name: 'Loan processing-fee collection', impact: 'CONFIRMED', evidence: 'One or more server-enforced policy/accounting prerequisites are missing.' },
      ] : [],
      recommendedAction: blockers.length
        ? 'Review the server-authoritative policy gate and KES chart of accounts. Do not bypass payment readiness.'
        : 'No action required. This check does not initiate a payment or post a ledger entry.',
      ...(blockers.length ? {
        incident: {
          category: 'FINANCIAL_CONFIGURATION_INCOMPLETE',
          title: 'Processing-fee accounting prerequisites incomplete',
          severity: 'WARNING' as const,
          description: blockers.join(' '),
          diagnosticEvidence: { blockers, currency: 'KES', providerContacted: false },
        },
      } : { recoveryEvidence: 'Processing-fee policy and KES clearing/revenue account prerequisites passed validation.' }),
    };
  }

  private async upsertIncident(
    tx: Prisma.TransactionClient,
    check: SystemHealthCheck & { incident: HealthIncidentSignal },
  ): Promise<SystemIncident> {
    const fingerprint = `${check.component}:${check.incident.category}`;
    const previous = await tx.systemIncident.findUnique({ where: { fingerprint } });
    const data = {
      title: check.incident.title,
      component: check.component,
      category: check.incident.category,
      severity: check.incident.severity,
      status: 'OPEN',
      description: check.incident.description,
      affectedModules: this.toJsonAffectedModules(check.affectedModules),
      diagnosticEvidence: check.incident.diagnosticEvidence,
      lastSeenAt: new Date(check.checkedAt),
      recoveredAt: null,
      recoveryEvidence: null,
      ...(previous?.status === 'RESOLVED' ? { acknowledgedAt: null, acknowledgedById: null } : {}),
    };
    const incident = previous
      ? await tx.systemIncident.update({
          where: { fingerprint },
          data: {
            ...data,
            status: previous.status === 'ACKNOWLEDGED' ? 'ACKNOWLEDGED' : 'OPEN',
            occurrenceCount: { increment: 1 },
          },
        })
      : await tx.systemIncident.create({
          data: {
            fingerprint,
            ...data,
            firstSeenAt: new Date(check.checkedAt),
            occurrenceCount: 1,
          },
        });
    return incident;
  }

  private async recoverComponentIncidents(tx: Prisma.TransactionClient, check: SystemHealthCheck) {
    const active = await tx.systemIncident.findMany({
      where: { component: check.component, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
      select: { id: true, fingerprint: true, category: true },
    });
    for (const incident of active) {
      await tx.systemIncident.update({
        where: { id: incident.id },
        data: {
          status: 'RESOLVED',
          recoveredAt: new Date(check.checkedAt),
          recoveryEvidence: check.recoveryEvidence ?? 'The component check passed its configured recovery condition.',
        },
      });
      await tx.adminAuditLog.create({
        data: {
          action: 'SYSTEM_INCIDENT_RECOVERED',
          subjectType: 'SYSTEM_INCIDENT',
          subjectId: incident.id,
          outcome: 'RECOVERED',
          reason: check.recoveryEvidence?.slice(0, 500) ?? 'Component check passed.',
        },
      });
    }
  }

  private async deliverAlert(incident: SystemIncident) {
    if (
      incident.severity !== 'CRITICAL' &&
      incident.severity !== 'ERROR' &&
      incident.category !== 'PAYMENT_RECONCILIATION_BACKLOG'
    ) return;
    try {
      const attemptedAt = new Date();
      const claimed = await this.prisma.systemIncidentAlert.createMany({
        data: [{
          incidentId: incident.id,
          channel: 'EMAIL',
          status: 'STARTED',
          attemptCount: 1,
          attemptedAt,
        }],
        skipDuplicates: true,
      });
      if (claimed.count !== 1) {
        const retry = await this.prisma.systemIncidentAlert.updateMany({
          where: {
            incidentId: incident.id,
            status: { in: ['FAILED', 'PARTIAL', 'UNAVAILABLE', 'STARTED'] },
            attemptCount: { lt: MAX_ALERT_ATTEMPTS },
            attemptedAt: { lte: new Date(attemptedAt.getTime() - ALERT_RETRY_COOLDOWN_MS) },
          },
          data: {
            status: 'STARTED',
            failureCategory: null,
            attemptedAt,
            completedAt: null,
            recipientCount: 0,
            deliveredCount: 0,
            attemptCount: { increment: 1 },
          },
        });
        if (retry.count !== 1) return;
      }
      if (!this.isEmailConfigured()) {
        await this.prisma.systemIncidentAlert.update({
          where: { incidentId: incident.id },
          data: { status: 'UNAVAILABLE', failureCategory: 'EMAIL_CONFIGURATION_MISSING', completedAt: new Date() },
        });
        return;
      }
      const recipients = await this.prisma.superadminUser.findMany({
        where: { isActive: true, emailVerifiedAt: { not: null }, role: 'SUPERADMIN' },
        select: { email: true },
      });
      if (!recipients.length) {
        await this.prisma.systemIncidentAlert.update({
          where: { incidentId: incident.id },
          data: { status: 'UNAVAILABLE', failureCategory: 'NO_VERIFIED_SUPERADMIN_RECIPIENT', completedAt: new Date() },
        });
        return;
      }
      let deliveredCount = 0;
      for (const recipient of recipients) {
        try {
          await this.mail.sendSystemIncidentAlert(recipient.email, incident);
          deliveredCount += 1;
        } catch {
          logger.warn(`System incident email delivery failed (incident=${incident.id}).`);
        }
      }
      await this.prisma.systemIncidentAlert.update({
        where: { incidentId: incident.id },
        data: {
          status: deliveredCount === recipients.length ? 'SENT' : deliveredCount ? 'PARTIAL' : 'FAILED',
          failureCategory: deliveredCount === recipients.length ? null : 'EMAIL_DELIVERY_FAILED',
          recipientCount: recipients.length,
          deliveredCount,
          completedAt: new Date(),
        },
      });
    } catch (error) {
      const category = error instanceof Prisma.PrismaClientKnownRequestError
        ? `PRISMA_${error.code}`
        : 'ALERT_PROCESSING_FAILED';
      logger.warn(`System incident alert could not be completed (incident=${incident.id}, category=${category}).`);
      try {
        await this.prisma.systemIncidentAlert.update({
          where: { incidentId: incident.id },
          data: { status: 'FAILED', failureCategory: category, completedAt: new Date() },
        });
      } catch {
        logger.warn(`System incident alert outcome could not be recorded (incident=${incident.id}).`);
      }
    }
  }

  private isEmailConfigured(): boolean {
    const apiKey = process.env.RESEND_API_KEY?.trim();
    const from = process.env.RESEND_FROM?.trim();
    if (!apiKey || !from) return false;
    const address = from.includes('<') && from.endsWith('>')
      ? from.slice(from.lastIndexOf('<') + 1, -1).trim()
      : from;
    return /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(address);
  }

  private getOverallStatus(checks: Array<{ status: string; stale: boolean }>): string {
    if (!checks.length) return 'UNKNOWN';
    if (checks.some((check) => check.status === 'DOWN' && !check.stale)) return 'DOWN';
    if (checks.some((check) => check.status === 'DEGRADED' && !check.stale)) return 'DEGRADED';
    if (checks.some((check) => check.stale)) return 'UNKNOWN';
    if (checks.every((check) => check.status === 'HEALTHY')) return 'HEALTHY';
    return 'UNKNOWN';
  }

  private getUnresolvedPaymentCount(checks: Array<{ component: string; explanation: string }>): number | null {
    const queue = checks.find((check) => check.component === 'payment_reconciliation');
    if (!queue || !/^\d+ aged pending, \d+ legacy 4999, and \d+ unresolved provider-query/.test(queue.explanation)) return null;
    const values = queue.explanation.match(/\d+/g)?.map(Number) ?? [];
    return values.reduce((sum, value) => sum + value, 0);
  }

  private readAffectedModules(value: Prisma.JsonValue): HealthAffectedModule[] {
    if (!Array.isArray(value)) return [];
    const modules: HealthAffectedModule[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      if (
        !('name' in entry) || typeof entry.name !== 'string' ||
        !('impact' in entry) || (entry.impact !== 'CONFIRMED' && entry.impact !== 'POTENTIAL') ||
        !('evidence' in entry) || typeof entry.evidence !== 'string'
      ) continue;
      modules.push({ name: entry.name, impact: entry.impact, evidence: entry.evidence });
    }
    return modules;
  }

  private toJsonAffectedModules(modules: HealthAffectedModule[]): Prisma.InputJsonArray {
    return modules.map((module): Prisma.InputJsonObject => ({
      name: module.name,
      impact: module.impact,
      evidence: module.evidence,
    }));
  }
}
