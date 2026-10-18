'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiRequest } from '@/lib/api';

interface AuditEvent {
  id: string;
  action: string;
  subjectType: string | null;
  subjectId: string | null;
  outcome: string;
  reason: string | null;
  details: unknown;
  createdAt: string;
  superadmin: { id: string; email: string } | null;
}

interface AuditPageResult {
  items: AuditEvent[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export default function AuditPage() {
  const router = useRouter();
  const [result, setResult] = useState<AuditPageResult | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [actorId, setActorId] = useState('');
  const [action, setAction] = useState('');
  const [resourceType, setResourceType] = useState('');
  const [outcome, setOutcome] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [applied, setApplied] = useState({ search: '', actorId: '', action: '', resourceType: '', outcome: '', from: '', to: '' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    const params = new URLSearchParams({ page: String(page), pageSize: '25' });
    for (const [key, value] of Object.entries(applied)) if (value.trim()) params.set(key, value.trim());
    try {
      setResult(await apiRequest<AuditPageResult>(`/admin/audit?${params.toString()}`, { cache: 'no-store' }));
    } catch (reason) {
      if (reason instanceof Error && reason.message.includes('Authentication required')) router.replace('/admin/login');
      setError(reason instanceof Error ? reason.message : 'Audit history could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [applied, page, router]);

  useEffect(() => { void refresh(); }, [refresh]);

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setApplied({ search, actorId, action, resourceType, outcome, from, to });
  }

  const events = result?.items ?? [];
  return <main className="dashboard-page"><header className="dashboard-top"><Link className="wordmark" href="/admin"><span className="brand-mark">L+</span> loanplus <span className="admin-tag">ADMIN</span></Link><Link className="quiet-button" href="/admin">Administration</Link></header><section className="dashboard-welcome"><p className="eyebrow">SECURITY &amp; AUDIT</p><h1>Administrative activity.</h1><p>Protected, append-only administrative records. Sensitive credentials and National ID values are excluded.</p></section>
    <form className="admin-payment-filters" onSubmit={applyFilters}>
      <label>Search<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Actor, action, resource, or reason" /></label>
      <label>Actor ID<input value={actorId} onChange={(event) => setActorId(event.target.value)} /></label>
      <label>Action<input value={action} onChange={(event) => setAction(event.target.value)} /></label>
      <label>Resource type<input value={resourceType} onChange={(event) => setResourceType(event.target.value)} /></label>
      <label>Outcome<input value={outcome} onChange={(event) => setOutcome(event.target.value)} /></label>
      <label>From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
      <label>To<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
      <div className="admin-filter-actions"><button className="button button-small" type="submit">Apply filters</button><button className="quiet-button" type="button" onClick={() => void refresh()}>Refresh</button></div>
    </form>
    {error && <p className="admin-inline-error" role="alert">{error}</p>}
    <p className="admin-page-controls">{loading ? 'Loading audit events…' : `${result?.total ?? 0} events · page ${result?.page ?? page} of ${Math.max(result?.pageCount ?? 0, 1)}`}</p>
    <section className="admin-audit-list">{events.length === 0 ? <p className="empty-copy">{loading ? 'Loading…' : 'No audit events match these filters.'}</p> : events.map((event) => <article key={event.id}><div><b>{event.action.replaceAll('_', ' ')}</b><small>{event.superadmin?.email ?? 'System'} · {event.superadmin?.id ?? 'no actor ID'} · {event.subjectType ?? 'SYSTEM'}{event.subjectId ? ` · ${event.subjectId}` : ''}</small>{event.reason && <p>{event.reason}</p>}<details><summary>Safe event details</summary><pre>{JSON.stringify(event.details, null, 2)}</pre></details></div><span className="status-label">{event.outcome}</span><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString('en-KE')}</time></article>)}</section>
    <div className="admin-page-controls"><span>{result ? `Showing ${events.length} of ${result.total}` : ''}</span><div><button type="button" disabled={loading || page <= 1} onClick={() => setPage((current) => current - 1)}>Previous</button><button type="button" disabled={loading || !result || page >= result.pageCount} onClick={() => setPage((current) => current + 1)}>Next</button></div></div>
  </main>;
}