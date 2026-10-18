'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiRequest } from '@/lib/api';
import { formatMoney } from '@/lib/currency';

interface Attempt {
  id: string;
  outcome: string;
  providerResultCode: string | null;
  reasonCode: string | null;
  operatorNote: string;
  requestedAt: string;
  completedAt: string | null;
  superadmin: { email: string };
}

interface ReconciliationPayment {
  id: string;
  internalReference: string;
  amountKes: number;
  currency: string;
  status: string;
  recordedStatus: string;
  providerReference: string | null;
  receiptReference: string | null;
  createdAt: string;
  updatedAt: string;
  user: { fullName: string; email: string };
  activationRequest: null | {
    checkoutRequestId: string | null;
    merchantRequestId: string | null;
    callbackEvents: Array<{ providerResultCode: string | null; providerReceiptReference: string | null; receivedAt: string }>;
  };
  reconciliationAttempts: Attempt[];
  _count: { reconciliationAttempts: number };
  reconciliationStatus: string;
}

interface ReconciliationPage {
  items: ReconciliationPayment[];
  nextCursor: string | null;
  pendingThresholdMinutes: number;
}

export default function AdminReconciliationPage() {
  const router = useRouter();
  const [items, setItems] = useState<ReconciliationPayment[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [pageCursor, setPageCursor] = useState<string | null>(null);
  const [pendingThresholdMinutes, setPendingThresholdMinutes] = useState(5);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadQueue = useCallback(async (cursor?: string | null) => {
    setLoading(true);
    setError('');
    const query = new URLSearchParams({ limit: '25' });
    if (cursor) query.set('cursor', cursor);
    try {
      const page = await apiRequest<ReconciliationPage>(`/admin/payment-reconciliation?${query}`, { cache: 'no-store' });
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setPageCursor(cursor ?? null);
      setPendingThresholdMinutes(page.pendingThresholdMinutes);
    } catch (reason) {
      if (reason instanceof Error && reason.message.includes('Authentication required')) router.replace('/admin/login');
      setError(reason instanceof Error ? reason.message : 'Reconciliation queue could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => { void loadQueue(); }, [loadQueue]);

  async function refreshPayment(payment: ReconciliationPayment) {
    const note = notes[payment.id]?.trim() ?? '';
    if (note.length < 10) return;
    setRefreshingId(payment.id);
    setError('');
    setNotice('');
    try {
      const result = await apiRequest<Attempt>(`/admin/payment-reconciliation/${payment.id}/refresh`, {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ note }),
      });
      const resultMessage = result.outcome === 'SUCCESS_AWAITING_VERIFIED_CALLBACK'
        ? 'Provider query returned success, but settlement still requires a validated callback with receipt metadata.'
        : `Reconciliation recorded: ${result.outcome.replaceAll('_', ' ').toLowerCase()}.`;
      setNotice(resultMessage);
      await loadQueue(pageCursor);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Provider status could not be refreshed.');
    } finally {
      setRefreshingId(null);
    }
  }

  return (
    <main className="dashboard-page admin-reconciliation-page">
      <header className="dashboard-top"><Link className="wordmark" href="/admin"><span className="brand-mark">L+</span> loanplus <span className="admin-tag">ADMIN</span></Link><Link className="quiet-button" href="/admin/payments">Payment search</Link></header>
      <section className="dashboard-welcome"><p className="eyebrow">PAYMENT RECONCILIATION</p><h1>Unresolved payments.</h1><p>Pending activation payments older than {pendingThresholdMinutes} minutes and legacy 4999 records. A status query never directly credits a wallet.</p></section>
      {error && <p className="admin-inline-error" role="alert">{error}</p>}
      {notice && <p className="admin-inline-notice" role="status">{notice}</p>}
      <section className="reconciliation-queue" aria-live="polite">
        {loading ? <p>Loading reconciliation queue…</p> : items.length === 0 ? <p className="empty-copy">No unresolved activation payments require review.</p> : items.map((payment) => (
          <article key={payment.id}>
            <div className="reconciliation-header"><div><b>{payment.user.fullName}</b><small>{payment.user.email} · {payment.internalReference}</small></div><span className="status-label status-pending">{payment.reconciliationStatus.replaceAll('_', ' ')}</span></div>
            <dl>
              <div><dt>Amount</dt><dd>{formatMoney(payment.amountKes)} {payment.currency}</dd></div>
              <div><dt>Queue status</dt><dd>{payment.status}</dd></div>
              <div><dt>Stored payment status</dt><dd>{payment.recordedStatus}</dd></div>
              <div><dt>Created</dt><dd>{new Date(payment.createdAt).toLocaleString('en-KE')}</dd></div>
              <div><dt>Last updated</dt><dd>{new Date(payment.updatedAt).toLocaleString('en-KE')}</dd></div>
              <div><dt>Checkout request</dt><dd>{payment.activationRequest?.checkoutRequestId ?? 'Unavailable'}</dd></div>
              <div><dt>Merchant request</dt><dd>{payment.activationRequest?.merchantRequestId ?? 'Unavailable'}</dd></div>
              <div><dt>Provider reference</dt><dd>{payment.providerReference ?? 'Not confirmed'}</dd></div>
              <div><dt>Verified receipt</dt><dd>{payment.receiptReference ?? 'Not verified'}</dd></div>
              <div><dt>Refresh attempts</dt><dd>{payment._count.reconciliationAttempts}</dd></div>
              {payment.reconciliationAttempts[0] && <div><dt>Last query</dt><dd>{payment.reconciliationAttempts[0].outcome.replaceAll('_', ' ')} · {new Date(payment.reconciliationAttempts[0].requestedAt).toLocaleString('en-KE')}</dd></div>}
            </dl>
            <div className="reconciliation-history"><b>Recent callbacks</b>{payment.activationRequest?.callbackEvents.length ? payment.activationRequest.callbackEvents.map((event, index) => <small key={`${event.receivedAt}-${index}`}>Result {event.providerResultCode ?? 'unknown'} · receipt {event.providerReceiptReference ? 'verified' : 'not present'} · {new Date(event.receivedAt).toLocaleString('en-KE')}</small>) : <small>No callback event recorded.</small>}</div>
            {payment.reconciliationAttempts.length > 0 && <div className="reconciliation-history"><b>Recent investigation notes</b>{payment.reconciliationAttempts.map((attempt) => <small key={attempt.id}>{new Date(attempt.requestedAt).toLocaleString('en-KE')} · {attempt.superadmin.email} · {attempt.operatorNote}</small>)}</div>}
            <label>Investigation note<textarea value={notes[payment.id] ?? ''} onChange={(event) => setNotes((current) => ({ ...current, [payment.id]: event.target.value }))} minLength={10} maxLength={500} placeholder="Record the reason for refreshing this provider status." /></label>
            <button className="button" type="button" disabled={refreshingId !== null || (notes[payment.id]?.trim().length ?? 0) < 10} onClick={() => void refreshPayment(payment)}>{refreshingId === payment.id ? 'Checking Safaricom…' : 'Refresh provider status'}</button>
          </article>
        ))}
      </section>
      <nav className="reconciliation-pagination" aria-label="Reconciliation pages">
        <button className="quiet-button" type="button" disabled={!pageCursor || loading} onClick={() => void loadQueue()}>First page</button>
        <button className="quiet-button" type="button" disabled={!nextCursor || loading} onClick={() => void loadQueue(nextCursor)}>Next page</button>
      </nav>
    </main>
  );
}
