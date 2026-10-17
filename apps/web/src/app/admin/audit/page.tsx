'use client';

import { useEffect, useState } from 'react';
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
  createdAt: string;
  superadmin: { email: string } | null;
}

export default function AuditPage() {
  const router = useRouter();
  const [events, setEvents] = useState<AuditEvent[]>([]);

  useEffect(() => {
    apiRequest<AuditEvent[]>('/admin/audit?limit=200').then(setEvents).catch(() => router.replace('/admin/login'));
  }, [router]);

  return <main className="dashboard-page"><header className="dashboard-top"><Link className="wordmark" href="/admin"><span className="brand-mark">L+</span> loanplus <span className="admin-tag">ADMIN</span></Link><Link className="quiet-button" href="/admin">Administration</Link></header><section className="dashboard-welcome"><p className="eyebrow">SECURITY &amp; AUDIT</p><h1>Administrative activity.</h1><p>Recent administrative actions from the protected audit log. Sensitive credentials and National ID values are not included.</p></section><section className="admin-audit-list">{events.length === 0 ? <p className="empty-copy">No audit events have been recorded yet.</p> : events.map((event) => <article key={event.id}><div><b>{event.action.replaceAll('_', ' ')}</b><small>{event.superadmin?.email ?? 'System'} · {event.subjectType ?? 'SYSTEM'}{event.subjectId ? ` · ${event.subjectId}` : ''}</small>{event.reason && <p>{event.reason}</p>}</div><span className="status-label">{event.outcome}</span><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString('en-KE')}</time></article>)}</section></main>;
}