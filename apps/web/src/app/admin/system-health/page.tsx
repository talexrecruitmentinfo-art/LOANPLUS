'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { apiRequest } from '@/lib/api';

interface AffectedModule {
  name: string;
  impact: 'CONFIRMED' | 'POTENTIAL';
  evidence: string;
}

interface HealthCheck {
  component: string;
  status: 'HEALTHY' | 'DEGRADED' | 'DOWN' | 'UNKNOWN';
  explanation: string;
  checkedAt: string;
  durationMs: number | null;
  lastSuccessAt: string | null;
  stale: boolean;
  affectedModules: AffectedModule[];
  recommendedAction: string;
}

interface Incident {
  id: string;
  title: string;
  component: string;
  category: string;
  severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
  description: string;
  affectedModules: AffectedModule[];
  diagnosticEvidence: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string;
  recoveredAt: string | null;
  recoveryEvidence: string | null;
  occurrenceCount: number;
  acknowledgedAt: string | null;
  notes: Array<{ id: string; actorId: string; note: string; createdAt: string }>;
  alert: null | {
    channel: string;
    status: string;
    failureCategory: string | null;
    recipientCount: number;
    deliveredCount: number;
    attemptCount: number;
    attemptedAt: string;
    completedAt: string | null;
  };
}

interface HealthDashboard {
  checkedAt: string | null;
  staleAfterSeconds: number;
  components: HealthCheck[];
  incidents: Incident[];
  incidentPagination: { total: number; page: number; pageSize: number; pageCount: number };
  metrics: {
    overallStatus: string;
    activeIncidents: number;
    criticalIncidents: number;
    unresolvedPaymentExceptions: number | null;
  };
  alertDelivery: { configured: boolean; provider: string; explanation: string };
}

const componentLabels: Record<string, string> = {
  api_process: 'API process',
  postgresql: 'PostgreSQL database',
  mpesa_configuration: 'M-Pesa configuration',
  email_delivery: 'Email delivery',
  background_jobs: 'Background jobs',
  website_publishing: 'Website publishing',
  payment_reconciliation: 'Payment reconciliation',
  financial_configuration: 'Financial configuration',
};

function formatTimestamp(value: string | null) {
  return value ? new Date(value).toLocaleString('en-KE') : 'Not observed';
}

export default function AdminSystemHealthPage() {
  const router = useRouter();
  const [dashboard, setDashboard] = useState<HealthDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [severityFilter, setSeverityFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [appliedFilters, setAppliedFilters] = useState({ severity: '', status: '', search: '' });
  const [incidentPage, setIncidentPage] = useState(1);
  const [busyIncident, setBusyIncident] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(incidentPage), pageSize: '20' });
      for (const [key, value] of Object.entries(appliedFilters)) if (value) params.set(key, value);
      setDashboard(await apiRequest<HealthDashboard>(`/admin/system-health?${params.toString()}`, { cache: 'no-store' }));
    } catch (reason) {
      if (reason instanceof Error && reason.message.includes('Authentication required')) router.replace('/admin/login');
      setError(reason instanceof Error ? reason.message : 'System health data could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [appliedFilters, incidentPage, router]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function runChecks() {
    setChecking(true);
    setError('');
    setNotice('');
    try {
      const result = await apiRequest<{ persisted: boolean; persistenceMessage: string }>('/admin/system-health/check', {
        method: 'POST',
        body: '{}',
      });
      if (!result.persisted) setError(result.persistenceMessage);
      else setNotice(result.persistenceMessage);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Health checks could not be completed.');
    } finally {
      setChecking(false);
    }
  }

  async function addNote(event: FormEvent<HTMLFormElement>, incidentId: string) {
    event.preventDefault();
    const form = event.currentTarget;
    const note = new FormData(form).get('note');
    setBusyIncident(incidentId);
    setError('');
    setNotice('');
    try {
      await apiRequest(`/admin/system-health/incidents/${encodeURIComponent(incidentId)}/notes`, {
        method: 'POST',
        body: JSON.stringify({ note }),
      });
      form.reset();
      setNotice('Investigation note recorded and audited.');
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The incident note could not be saved.');
    } finally {
      setBusyIncident('');
    }
  }

  async function acknowledge(event: FormEvent<HTMLFormElement>, incidentId: string) {
    event.preventDefault();
    const form = event.currentTarget;
    const reason = new FormData(form).get('reason');
    setBusyIncident(incidentId);
    setError('');
    setNotice('');
    try {
      await apiRequest(`/admin/system-health/incidents/${encodeURIComponent(incidentId)}/acknowledge`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
      form.reset();
      setNotice('Incident acknowledged. It remains active until a health check confirms recovery.');
      await refresh();
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : 'The incident could not be acknowledged.');
    } finally {
      setBusyIncident('');
    }
  }

  function applyIncidentFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIncidentPage(1);
    setAppliedFilters({
      severity: severityFilter === 'ALL' ? '' : severityFilter,
      status: statusFilter === 'ALL' ? '' : statusFilter,
      search: search.trim(),
    });
  }

  const cards = [
    { label: 'Overall health', value: dashboard?.metrics.overallStatus ?? 'UNKNOWN', detail: dashboard?.checkedAt ? `Last checked ${formatTimestamp(dashboard.checkedAt)}` : 'No successful check recorded' },
    { label: 'API availability', value: dashboard?.components.find((check) => check.component === 'api_process')?.status ?? 'UNKNOWN', detail: 'Current authenticated API response' },
    { label: 'Database', value: dashboard?.components.find((check) => check.component === 'postgresql')?.status ?? 'UNKNOWN', detail: 'Read-only connectivity probe' },
    { label: 'M-Pesa', value: dashboard?.components.find((check) => check.component === 'mpesa_configuration')?.status ?? 'UNKNOWN', detail: 'Configuration only; provider not queried' },
    { label: 'Background jobs', value: dashboard?.components.find((check) => check.component === 'background_jobs')?.status ?? 'UNKNOWN', detail: 'No worker is configured/observed' },
    { label: 'Active incidents', value: dashboard?.metrics.activeIncidents ?? '—', detail: `${dashboard?.metrics.criticalIncidents ?? 0} critical` },
    { label: 'Payment exceptions', value: dashboard?.metrics.unresolvedPaymentExceptions ?? 'Unavailable', detail: 'Aged pending, legacy 4999, provider review' },
  ];

  return (
    <main className="dashboard-page admin-system-health">
      <section className="dashboard-welcome">
        <p className="eyebrow">OPERATIONS · SYSTEM HEALTH</p>
        <div className="admin-dashboard-title">
          <div><h1>System health.</h1><p>On-demand observations, incident history, and safe diagnostics. Unknown means the component was not verified.</p></div>
          <button className="button button-small" type="button" disabled={checking} onClick={() => void runChecks()}>{checking ? 'Checking…' : 'Run health checks'}</button>
        </div>
      </section>
      {error && <p className="admin-inline-error" role="alert">{error}</p>}
      {notice && <p className="admin-inline-notice" role="status">{notice}</p>}
      {dashboard?.checkedAt && <p className="admin-health-stale-note">Latest recorded check: {formatTimestamp(dashboard.checkedAt)} · observations become stale after {Math.round(dashboard.staleAfterSeconds / 60)} minutes. Checks are manual; no scheduler is configured.</p>}
      <section className="admin-health-metrics" aria-label="System health metrics">
        {cards.map((card) => <article key={card.label}><span>{card.label}</span><b className={`health-${String(card.value).toLowerCase().replaceAll(' ', '-')}`}>{card.value}</b><small>{card.detail}</small></article>)}
      </section>
      <section className="admin-workspace admin-health-workspace">
        <div className="admin-workspace-heading"><div><p className="eyebrow">OBSERVED COMPONENTS</p><h2>Component checks</h2></div><button className="quiet-button" type="button" disabled={loading} onClick={() => void refresh()}>{loading ? 'Refreshing…' : 'Refresh history'}</button></div>
        {!dashboard?.components.length && !loading && <p className="empty-copy">No health observations yet. Run checks to record the first result.</p>}
        {loading && <p>Loading health observations…</p>}
        {dashboard?.components.map((check) => (
          <article className="admin-health-component" key={check.component}>
            <div className="health-component-title"><div><b>{componentLabels[check.component] ?? check.component}</b><small>{check.durationMs === null ? 'No measurable check duration' : `${check.durationMs} ms`}{check.stale ? ' · STALE' : ''}</small></div><span className={`health-status health-${check.stale ? 'stale' : check.status.toLowerCase()}`}>{check.stale ? 'STALE' : check.status}</span></div>
            <p>{check.explanation}</p>
            <dl><div><dt>Last checked</dt><dd>{formatTimestamp(check.checkedAt)}</dd></div><div><dt>Last successful check</dt><dd>{formatTimestamp(check.lastSuccessAt)}</dd></div></dl>
            {check.affectedModules.length > 0 && <div className="admin-health-affected"><b>Affected modules and evidence</b>{check.affectedModules.map((module) => <p key={`${module.name}-${module.impact}`}><span>{module.impact}</span> · {module.name}: {module.evidence}</p>)}</div>}
            <p className="health-recommended-action"><b>Recommended action:</b> {check.recommendedAction}</p>
          </article>
        ))}
      </section>
      <section className="admin-workspace admin-health-workspace">
        <div className="admin-workspace-heading"><div><p className="eyebrow">INCIDENT MANAGEMENT</p><h2>Incidents &amp; alert history</h2></div><span>Recent {dashboard?.incidents.length ?? 0} records</span></div>
        <form className="admin-health-filters" onSubmit={applyIncidentFilters}>
          <label>Search<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Incident title, component or evidence" /></label>
          <label>Severity<select value={severityFilter} onChange={(event) => setSeverityFilter(event.target.value)}><option value="ALL">All severities</option><option>CRITICAL</option><option>ERROR</option><option>WARNING</option><option>INFO</option></select></label>
          <label>Status<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="ALL">All states</option><option>OPEN</option><option>ACKNOWLEDGED</option><option>RESOLVED</option></select></label>
          <button className="button button-small" type="submit">Apply filters</button>
        </form>
        {dashboard && <p className="admin-health-alert-config">{dashboard.alertDelivery.explanation} Alerts are deduplicated per incident; no alert includes credentials or payment payloads.</p>}
        {(dashboard?.incidents.length ?? 0) === 0 && <p className="empty-copy">{loading ? 'Loading incidents…' : 'No incident records match these filters.'}</p>}
        <div className="admin-health-incidents">
          {(dashboard?.incidents ?? []).map((incident) => <article key={incident.id}>
            <div className="incident-row-heading"><div><b>{incident.title}</b><small>{incident.component} · {incident.category} · {incident.occurrenceCount} observations</small></div><div><span className={`health-status health-${incident.severity.toLowerCase()}`}>{incident.severity}</span> <span className={`health-status incident-${incident.status.toLowerCase()}`}>{incident.status}</span></div></div>
            <p>{incident.description}</p>
            <dl><div><dt>First seen</dt><dd>{formatTimestamp(incident.firstSeenAt)}</dd></div><div><dt>Last seen</dt><dd>{formatTimestamp(incident.lastSeenAt)}</dd></div><div><dt>Recovered</dt><dd>{formatTimestamp(incident.recoveredAt)}</dd></div><div><dt>Incident reference</dt><dd>{incident.id}</dd></div></dl>
            {incident.recoveryEvidence && <p className="health-recommended-action"><b>Recovery evidence:</b> {incident.recoveryEvidence}</p>}
            {incident.affectedModules.length > 0 && <div className="admin-health-affected"><b>Affected modules and evidence</b>{incident.affectedModules.map((module) => <p key={`${module.name}-${module.impact}`}><span>{module.impact}</span> · {module.name}: {module.evidence}</p>)}</div>}
            <details className="admin-health-details"><summary>Diagnostic evidence &amp; notifications</summary><pre>{JSON.stringify(incident.diagnosticEvidence, null, 2)}</pre><div className="incident-alert-detail"><b>Email alert</b><span>{incident.alert ? `${incident.alert.status} · ${incident.alert.deliveredCount}/${incident.alert.recipientCount} delivered · ${incident.alert.attemptCount} attempts` : 'Not applicable or not attempted'}</span>{incident.alert?.failureCategory && <small>{incident.alert.failureCategory}</small>}</div></details>
            <div className="incident-notes">{incident.notes.map((note) => <p key={note.id}><b>{note.actorId}</b> · {formatTimestamp(note.createdAt)}<br />{note.note}</p>)}{incident.notes.length === 0 && <small>No investigation notes recorded.</small>}</div>
            {incident.status !== 'RESOLVED' && <div className="incident-operator-actions">
              <form onSubmit={(event) => void addNote(event, incident.id)}><label>Add investigation note<textarea name="note" minLength={10} maxLength={1000} rows={2} required /></label><button className="quiet-button" disabled={busyIncident === incident.id}>{busyIncident === incident.id ? 'Saving…' : 'Record note'}</button></form>
              {incident.status === 'OPEN' && <form onSubmit={(event) => void acknowledge(event, incident.id)}><label>Acknowledgement reason<textarea name="reason" minLength={10} maxLength={500} rows={2} required /></label><button className="button button-small" disabled={busyIncident === incident.id}>Acknowledge</button></form>}
            </div>}
          </article>)}
        </div>
        <div className="admin-page-controls"><span>{dashboard ? `Page ${dashboard.incidentPagination.page} of ${Math.max(dashboard.incidentPagination.pageCount, 1)} · ${dashboard.incidentPagination.total} incidents` : ''}</span><div><button type="button" disabled={loading || incidentPage <= 1} onClick={() => setIncidentPage((current) => current - 1)}>Previous</button><button type="button" disabled={loading || !dashboard || incidentPage >= dashboard.incidentPagination.pageCount} onClick={() => setIncidentPage((current) => current + 1)}>Next</button></div></div>
      </section>
    </main>
  );
}
