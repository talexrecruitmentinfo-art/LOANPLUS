'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { apiRequest } from '@/lib/api';

interface Ticket {
  id: string;
  reference: string;
  subject: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  messages: Array<{ id: string; authorType: string; message: string; createdAt: string }>;
}

export default function SupportPage() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async (): Promise<boolean> => {
    setLoading(true);
    setLoadError('');
    try {
      setTickets(await apiRequest<Ticket[]>('/support/tickets'));
      return true;
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : 'Support requests could not be loaded.');
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    setSubmitError('');
    setNotice('');
    const values = Object.fromEntries(new FormData(form).entries());
    try {
      await apiRequest('/support/tickets', { method: 'POST', body: JSON.stringify(values) });
      form.reset();
      setNotice('Your request was sent. You can follow its status below.');
      await refresh();
    } catch (reason) {
      setSubmitError(reason instanceof Error ? reason.message : 'The support request could not be submitted.');
    } finally {
      setBusy(false);
    }
  }

  return <main className="dashboard-page"><header className="dashboard-top"><Link className="wordmark" href="/dashboard"><span className="brand-mark">L+</span> loanplus</Link><Link className="quiet-button" href="/dashboard">My account</Link></header><section className="dashboard-welcome"><p className="eyebrow">CUSTOMER SUPPORT</p><h1>How can we help?</h1><p>Send a message to LoanPlus support and follow the ticket status here. Do not include passwords, full National ID numbers or payment credentials.</p></section><section className="support-content"><form className="support-form" onSubmit={submit}><label>Subject<input name="subject" minLength={4} maxLength={160} required /></label><label>Message<textarea name="message" minLength={10} maxLength={4000} rows={5} required /></label>{submitError && <p className="form-error" role="alert">{submitError}</p>}{notice && <p className="form-success" role="status">{notice}</p>}<button className="button" disabled={busy}>{busy ? 'Sending…' : 'Submit support request'} <span aria-hidden="true">↗</span></button></form><div className="customer-ledger-heading"><h2>Your support requests</h2><button className="quiet-button" type="button" disabled={loading} onClick={() => void refresh()}>{loading ? 'Refreshing…' : 'Refresh'}</button></div>{loadError && <div className="support-load-error" role="alert"><p>{loadError}</p><p>If you have been signed out, sign in again before retrying.</p><Link className="legal-home" href="/login">Sign in</Link></div>}{loading && tickets.length === 0 ? <p role="status">Loading your support requests…</p> : tickets.length === 0 ? loadError ? null : <p className="empty-copy">No support requests yet.</p> : <div className="ticket-list">{tickets.map((ticket) => <article key={ticket.id}><div className="ticket-heading"><div><b>{ticket.subject}</b><small>{ticket.reference} · {new Date(ticket.createdAt).toLocaleDateString('en-KE')}</small></div><span className="status-label">{ticket.status.replaceAll('_', ' ')}</span></div>{ticket.messages.map((message) => <div className="ticket-message" key={message.id}><small>{message.authorType === 'SUPERADMIN' ? 'LoanPlus support' : 'You'} · {new Date(message.createdAt).toLocaleString('en-KE')}</small><p>{message.message}</p></div>)}</article>)}</div>}</section></main>;
}