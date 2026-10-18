'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
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
  type: string;
  internalReference: string;
  amountKes: number;
  currency: string;
  status: string;
  recordedStatus: string;
  reasonForInclusion: 'AGED_PENDING' | 'LEGACY_UNRESOLVED_4999' | 'PROVIDER_REVIEW_REQUIRED' | 'ESCALATED';
  providerReference: string | null;
  receiptReference: string | null;
  createdAt: string;
  updatedAt: string;
  activationRequest: null | {
    checkoutRequestId: string | null;
    merchantRequestId: string | null;
    callbackEvents: Array<{ providerResultCode: string | null; providerReceiptReference: string | null; receivedAt: string }>;
  };
  reconciliationAttempts: Attempt[];
  _count: { reconciliationAttempts: number };
  reconciliationStatus: string;
}

type QueueCategory = 'ALL' | 'AGED_PENDING' | 'LEGACY_4999' | 'PROVIDER_REVIEW';

function isQueueCategory(value: string): value is QueueCategory {
  return value === 'ALL' || value === 'AGED_PENDING' || value === 'LEGACY_4999' || value === 'PROVIDER_REVIEW';
}

interface ReconciliationPage {
  items: ReconciliationPayment[];
  nextCursor: string | null;
  pendingThresholdMinutes: number;
  category: QueueCategory;
}

export default function AdminReconciliationPage() {
  const router = useRouter();
  const [items, setItems] = useState<ReconciliationPayment[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [pageCursor, setPageCursor] = useState<string | null>(null);
  const [pendingThresholdMinutes, setPendingThresholdMinutes] = useState(5);
  const [search, setSearch] = useState('');
  const [activeSearch, setActiveSearch] = useState('');
  const [category, setCategory] = useState<QueueCategory>('ALL');
  const [activeCategory, setActiveCategory] = useState<QueueCategory>('ALL');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [escalatingId, setEscalatingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadQueue = useCallback(async (
    cursor: string | null | undefined,
    searchTerm: string,
    queueCategory: QueueCategory,
  ) => {
    setLoading(true);
    setError('');
    const query = new URLSearchParams({ limit: '25' });
    if (cursor) query.set('cursor', cursor);
    if (searchTerm) query.set('search', searchTerm);
    query.set('category', queueCategory);
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

  useEffect(() => { void loadQueue(undefined, '', 'ALL'); }, [loadQueue]);

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedSearch = search.trim();
    setActiveSearch(normalizedSearch);
    setActiveCategory(category);
    setPageCursor(null);
    void loadQueue(null, normalizedSearch, category);
  }

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
      await loadQueue(pageCursor, activeSearch, activeCategory);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Provider status could not be refreshed.');
    } finally {
      setRefreshingId(null);
    }
  }

  async function escalatePayment(payment: ReconciliationPayment) {
    const note = notes[payment.id]?.trim() ?? '';
    if (note.length < 10) return;
    setEscalatingId(payment.id);
    setError('');
    setNotice('');
    try {
      await apiRequest<Attempt>(`/admin/payment-reconciliation/${payment.id}/escalate`, {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ note }),
      });
      setNotice('Escalation recorded for provider investigation. The payment state was not changed.');
      await loadQueue(pageCursor, activeSearch, activeCategory);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Payment escalation could not be recorded.');
    } finally {
      setEscalatingId(null);
    }
  }

  return (
    <main className="dashboard-page admin-reconciliation-page">
      <header className="dashboard-top"><Link className="wordmark" href="/admin"><span className="brand-mark">L+</span> loanplus <span className="admin-tag">ADMIN</span></Link><Link className="quiet-button" href="/admin/payments">Payment search</Link></header>
      <section className="dashboard-welcome"><p className="eyebrow">PAYMENT RECONCILIATION</p><h1>Unresolved payments.</h1><p>Aged pending payments, legacy 4999 records and active provider-review exceptions. A status query never directly credits a wallet.</p></section>
      <form className="admin-payment-filters" onSubmit={applyFilters}>
        <label>Payment, provider, or receipt reference<input value={search} onChange={(event) => setSearch(event.target.value)} maxLength={40} placeholder="Enter an exact reference" /></label>
        <label>Queue category<select value={category} onChange={(event) => {
          if (isQueueCategory(event.target.value)) setCategory(event.target.value);
        }}>
          <option value="ALL">All unresolved</option>
          <option value="AGED_PENDING">Aged pending</option>
          <option value="LEGACY_4999">Legacy 4999</option>
          <option value="PROVIDER_REVIEW">Provider review</option>
        </select></label>
        <button className="button" type="submit" disabled={loading}>Apply filters</button>
      </form>
      {error && <p className="admin-inline-error" role="alert">{error}</p>}
      {notice && <p className="admin-inline-notice" role="status">{notice}</p>}
      <section className="reconciliation-queue" aria-live="polite">
        {loading ? <p>Loading reconciliation queue…</p> : items.length === 0 ? <p className="empty-copy">No unresolved payments match these filters.</p> : items.map((payment) => (
          <article key={payment.id}>
            <div className="reconciliation-header"><div><b>{payment.internalReference}</b><small>{payment.type === 'LOAN_PROCESSING_FEE' ? 'Loan Processing Fee' : 'Historical activation payment'} · {payment.reconciliationStatus.replaceAll('_', ' ')}</small></div><span className="status-label status-pending">{payment.reconciliationStatus.replaceAll('_', ' ')}</span></div>
            <dl>
              <div><dt>Reason in queue</dt><dd>{payment.reasonForInclusion === 'LEGACY_UNRESOLVED_4999'
                ? 'Legacy 4999 result remains unresolved regardless of age.'
                : payment.reasonForInclusion === 'ESCALATED'
                  ? 'This unresolved payment has an open provider-investigation escalation.'
                  : payment.reasonForInclusion === 'PROVIDER_REVIEW_REQUIRED'
                    ? 'A provider query or callback result requires investigation.'
                    : `Pending beyond the ${pendingThresholdMinutes}-minute investigation threshold.`}</dd></div>
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
              {payment.reconciliationAttempts[0] && <div><dt>Last reconciliation action</dt><dd>{payment.reconciliationAttempts[0].outcome.replaceAll('_', ' ')} · {new Date(payment.reconciliationAttempts[0].requestedAt).toLocaleString('en-KE')}</dd></div>}
            </dl>
            <div className="reconciliation-history"><b>Recent callbacks</b>{payment.activationRequest?.callbackEvents.length ? payment.activationRequest.callbackEvents.map((event, index) => <small key={`${event.receivedAt}-${index}`}>Result {event.providerResultCode ?? 'unknown'} · receipt {event.providerReceiptReference ? 'verified' : 'not present'} · {new Date(event.receivedAt).toLocaleString('en-KE')}</small>) : <small>No callback event recorded.</small>}</div>
            {payment.reconciliationAttempts.length > 0 && <div className="reconciliation-history"><b>Recent investigation notes</b>{payment.reconciliationAttempts.map((attempt) => <small key={attempt.id}>{new Date(attempt.requestedAt).toLocaleString('en-KE')} · {attempt.superadmin.email} · {attempt.operatorNote}</small>)}</div>}
            <label>Investigation note<textarea value={notes[payment.id] ?? ''} onChange={(event) => setNotes((current) => ({ ...current, [payment.id]: event.target.value }))} minLength={10} maxLength={500} placeholder="Record the reason for refreshing this provider status." /></label>
            {payment.reconciliationStatus === 'ESCALATED' && <p role="status">Escalated for provider investigation; wait for authoritative evidence before taking further action.</p>}
            <div className="reconciliation-actions">
              <button className="button" type="button" disabled={refreshingId !== null || escalatingId !== null || (notes[payment.id]?.trim().length ?? 0) < 10} onClick={() => void refreshPayment(payment)}>{refreshingId === payment.id ? 'Checking Safaricom…' : 'Refresh provider status'}</button>
              <button className="quiet-button" type="button" disabled={refreshingId !== null || escalatingId !== null || (notes[payment.id]?.trim().length ?? 0) < 10} onClick={() => void escalatePayment(payment)}>{escalatingId === payment.id ? 'Recording escalation…' : 'Escalate for investigation'}</button>
            </div>
          </article>
        ))}
      </section>
      <nav className="reconciliation-pagination" aria-label="Reconciliation pages">
        <button className="quiet-button" type="button" disabled={!pageCursor || loading} onClick={() => void loadQueue(undefined, activeSearch, activeCategory)}>First page</button>
        <button className="quiet-button" type="button" disabled={!nextCursor || loading} onClick={() => void loadQueue(nextCursor, activeSearch, activeCategory)}>Next page</button>
      </nav>
    </main>
  );
}
