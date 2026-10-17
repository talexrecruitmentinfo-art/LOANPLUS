'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiRequest } from '@/lib/api';

interface AdminTicket {
  id: string;
  reference: string;
  subject: string;
  status: string;
  createdAt: string;
  user: { id: string; fullName: string; email: string };
  messages: Array<{ id: string; authorType: string; authorId: string; message: string; createdAt: string }>;
}

export default function AdminSupportPage() {
  const router = useRouter();
  const [tickets, setTickets] = useState<AdminTicket[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function refresh() {
    setTickets(await apiRequest<AdminTicket[]>('/admin/support/tickets'));
  }

  useEffect(() => { refresh().catch(() => router.replace('/admin/login')); }, [router]);

  async function reply(event: FormEvent<HTMLFormElement>, ticket: AdminTicket) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    setError('');
    const values = Object.fromEntries(new FormData(form).entries());
    try {
      await apiRequest(`/admin/support/tickets/${ticket.id}/reply`, {
        method: 'PATCH',
        body: JSON.stringify(values),
      });
      form.reset();
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Reply could not be sent.');
    } finally {
      setBusy(false);
    }
  }

  return <main className="dashboard-page"><header className="dashboard-top"><Link className="wordmark" href="/admin"><span className="brand-mark">L+</span> loanplus <span className="admin-tag">ADMIN</span></Link><Link className="quiet-button" href="/admin">Administration</Link></header><section className="dashboard-welcome"><p className="eyebrow">CUSTOMER SUPPORT</p><h1>Ticket queue.</h1><p>Customer messages are visible only to the assigned support role. Responses and status changes are recorded in the administrative audit log.</p></section>{error && <p className="admin-inline-error" role="alert">{error}</p>}<section className="admin-workspace"><div className="admin-workspace-heading"><div><p className="eyebrow">INBOX</p><h2>Support tickets</h2></div><span>{tickets.length} tickets</span></div>{tickets.length === 0 ? <p className="empty-copy">No support tickets have been submitted.</p> : <div className="ticket-list">{tickets.map((ticket) => <article key={ticket.id}><div className="ticket-heading"><div><b>{ticket.subject}</b><small>{ticket.reference} · {ticket.user.fullName} · {ticket.user.email}</small></div><span className="status-label">{ticket.status.replaceAll('_', ' ')}</span></div>{ticket.messages.map((message) => <div className="ticket-message" key={message.id}><small>{message.authorType === 'SUPERADMIN' ? 'Support' : ticket.user.fullName} · {new Date(message.createdAt).toLocaleString('en-KE')}</small><p>{message.message}</p></div>)}{!['CLOSED'].includes(ticket.status) && <form className="support-reply-form" onSubmit={(event) => reply(event, ticket)}><label>Reply<textarea name="message" minLength={2} maxLength={4000} rows={3} required /></label><label>Set ticket status<select name="status" defaultValue="WAITING_FOR_CUSTOMER"><option value="IN_PROGRESS">In progress</option><option value="WAITING_FOR_CUSTOMER">Waiting for customer</option><option value="RESOLVED">Resolved</option><option value="CLOSED">Closed</option></select></label><button className="button" disabled={busy}>Send reply</button></form>}</article>)}</div>}</section></main>;
}