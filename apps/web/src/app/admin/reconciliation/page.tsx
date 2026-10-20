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
  submittedAccountReference: string | null;
  submittedCheckoutRequestId: string | null;
  submittedMerchantRequestId: string | null;
  evidenceSource: string | null;
  evidenceReference: string | null;
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
  initiationPhase: string | null;
  accountReference: string | null;
  reasonForInclusion: 'AGED_PENDING' | 'LEGACY_UNRESOLVED_4999' | 'PROVIDER_REVIEW_REQUIRED' | 'ESCALATED';
  providerReference: string | null;
  receiptReference: string | null;
  needsProviderIdentifiers: boolean;
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
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([]);
  const [pendingThresholdMinutes, setPendingThresholdMinutes] = useState(5);
  const [search, setSearch] = useState('');
  const [activeSearch, setActiveSearch] = useState('');
  const [category, setCategory] = useState<QueueCategory>('ALL');
  const [activeCategory, setActiveCategory] = useState<QueueCategory>('ALL');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [providerIdentifiers, setProviderIdentifiers] = useState<Record<string, { accountReference: string; checkoutRequestId: string; merchantRequestId: string; evidenceSource: string; evidenceReference: string }>>({});
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [escalatingId, setEscalatingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [adminRole, setAdminRole] = useState<string | null>(null);
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
      return true;
    } catch (reason) {
      if (reason instanceof Error && reason.message.includes('Authentication required')) router.replace('/admin/login');
      setError(reason instanceof Error ? reason.message : 'Reconciliation queue could not be loaded.');
      return false;
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => { void loadQueue(undefined, '', 'ALL'); }, [loadQueue]);

  useEffect(() => {
    let active = true;
    apiRequest<{ role: string }>('/admin/auth/me', { cache: 'no-store' })
      .then((identity) => {
        if (active) setAdminRole(identity.role);
      })
      .catch((reason) => {
        if (!active) return;
        if (reason instanceof Error && reason.message.includes('Authentication required')) {
          router.replace('/admin/login');
          return;
        }
        setError(reason instanceof Error ? reason.message : 'Administrator permissions could not be confirmed.');
      });
    return () => { active = false; };
  }, [router]);

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedSearch = search.trim();
    setActiveSearch(normalizedSearch);
    setActiveCategory(category);
    setPageCursor(null);
    setCursorHistory([]);
    void loadQueue(null, normalizedSearch, category);
  }

  async function refreshPayment(payment: ReconciliationPayment) {
    if (adminRole !== 'SUPERADMIN' || refreshingId !== null || escalatingId !== null) return;
    const note = notes[payment.id]?.trim() ?? '';
    if (note.length < 10) return;
    const identifiers = providerIdentifiers[payment.id];
    if (payment.needsProviderIdentifiers && (!identifiers?.accountReference.trim() || !identifiers.checkoutRequestId.trim() || !identifiers.merchantRequestId.trim() || !identifiers.evidenceSource || (identifiers.evidenceReference.trim().length < 3))) return;
    const action = payment.needsProviderIdentifiers ? 'submit this provider evidence for independent review' : 'query Safaricom for this payment status';
    if (!window.confirm(`Confirm ${action} for ${payment.internalReference}? This will not change the payment status or credit the wallet.`)) return;
    setRefreshingId(payment.id);
    setError('');
    setNotice('');
    try {
      const result = await apiRequest<Attempt>(`/admin/payment-reconciliation/${payment.id}/refresh`, {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          note,
          ...(payment.needsProviderIdentifiers ? {
            accountReference: identifiers?.accountReference.trim(),
            checkoutRequestId: identifiers?.checkoutRequestId.trim(),
            merchantRequestId: identifiers?.merchantRequestId.trim(),
            evidenceSource: identifiers?.evidenceSource,
            evidenceReference: identifiers?.evidenceReference.trim(),
          } : {}),
        }),
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

  async function verifyProviderEvidence(payment: ReconciliationPayment, attempt: Attempt) {
    if (adminRole !== 'SUPERADMIN' || refreshingId !== null || escalatingId !== null) return;
    const note = notes[payment.id]?.trim() ?? '';
    if (note.length < 10) return;
    if (!window.confirm(`Confirm independent review of the cited Safaricom evidence for ${payment.internalReference}?`)) return;
    setRefreshingId(payment.id);
    setError('');
    setNotice('');
    try {
      const result = await apiRequest<Attempt>(`/admin/payment-reconciliation/${payment.id}/verify-evidence`, {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ evidenceAttemptId: attempt.id, note, evidenceReviewed: true }),
      });
      setNotice(`Evidence review recorded: ${result.outcome.replaceAll('_', ' ').toLowerCase()}.`);
      await loadQueue(pageCursor, activeSearch, activeCategory);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Provider evidence could not be reviewed.');
    } finally {
      setRefreshingId(null);
    }
  }

  async function escalatePayment(payment: ReconciliationPayment) {
    if (adminRole !== 'SUPERADMIN' || refreshingId !== null || escalatingId !== null) return;
    const note = notes[payment.id]?.trim() ?? '';
    if (note.length < 10) return;
    if (payment.reasonForInclusion === 'ESCALATED') return;
    if (!window.confirm(`Escalate ${payment.internalReference} for provider investigation? This records an audit entry and does not change payment status.`)) return;
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

  async function goToFirstPage() {
    if (await loadQueue(null, activeSearch, activeCategory)) setCursorHistory([]);
  }

  async function goToPreviousPage() {
    if (cursorHistory.length === 0) return;
    const previousCursor = cursorHistory[cursorHistory.length - 1];
    if (await loadQueue(previousCursor, activeSearch, activeCategory)) {
      setCursorHistory((history) => history.slice(0, -1));
    }
  }

  async function goToNextPage() {
    if (!nextCursor) return;
    const currentCursor = pageCursor;
    if (await loadQueue(nextCursor, activeSearch, activeCategory)) {
      setCursorHistory((history) => [...history, currentCursor]);
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
            <div className="reconciliation-header"><div><b>{payment.internalReference}</b><small>{payment.type === 'LOAN_PROCESSING_FEE' ? 'Loan Processing Fee' : payment.type === 'WALLET_DEPOSIT' ? 'Wallet Deposit' : 'Historical activation payment'} · {payment.reconciliationStatus.replaceAll('_', ' ')}{payment.initiationPhase ? ` · ${payment.initiationPhase.replaceAll('_', ' ')}` : ''}</small></div><span className="status-label status-pending">{payment.reconciliationStatus.replaceAll('_', ' ')}</span></div>
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
              {payment.needsProviderIdentifiers && <div><dt>Expected AccountReference</dt><dd>{payment.accountReference ?? 'Unavailable'}</dd></div>}
              <div><dt>Provider reference</dt><dd>{payment.providerReference ?? 'Not confirmed'}</dd></div>
              <div><dt>Verified receipt</dt><dd>{payment.receiptReference ?? 'Not verified'}</dd></div>
              <div><dt>Refresh attempts</dt><dd>{payment._count.reconciliationAttempts}</dd></div>
              {payment.reconciliationAttempts[0] && <div><dt>Last reconciliation action</dt><dd>{payment.reconciliationAttempts[0].outcome.replaceAll('_', ' ')} · {new Date(payment.reconciliationAttempts[0].requestedAt).toLocaleString('en-KE')}</dd></div>}
            </dl>
            <div className="reconciliation-history"><b>Recent callbacks</b>{payment.activationRequest?.callbackEvents.length ? payment.activationRequest.callbackEvents.map((event, index) => <small key={`${event.receivedAt}-${index}`}>Result {event.providerResultCode ?? 'unknown'} · receipt {event.providerReceiptReference ? 'verified' : 'not present'} · {new Date(event.receivedAt).toLocaleString('en-KE')}</small>) : <small>No callback event recorded.</small>}</div>
            {payment.reconciliationAttempts.length > 0 && <div className="reconciliation-history"><b>Recent investigation notes</b>{payment.reconciliationAttempts.map((attempt) => <div key={attempt.id}><small>{new Date(attempt.requestedAt).toLocaleString('en-KE')} · {attempt.superadmin.email} · {attempt.operatorNote}{attempt.submittedAccountReference && attempt.submittedCheckoutRequestId && attempt.submittedMerchantRequestId ? ` · ${attempt.evidenceSource ?? 'Evidence source not recorded'} ${attempt.evidenceReference ?? ''} · AccountReference ${attempt.submittedAccountReference} · Safaricom IDs ${attempt.submittedCheckoutRequestId} / ${attempt.submittedMerchantRequestId}` : ''}</small>{payment.needsProviderIdentifiers && attempt.outcome === 'EVIDENCE_SUBMITTED_AWAITING_REVIEW' && <div><p role="status">Compare the cited Safaricom record with this payment. A different Superadmin must complete this review before LoanPlus queries Safaricom or binds the IDs.</p>{adminRole === 'SUPERADMIN' && <button className="quiet-button" type="button" disabled={refreshingId !== null || escalatingId !== null || (notes[payment.id]?.trim().length ?? 0) < 10} onClick={() => void verifyProviderEvidence(payment, attempt)}>{refreshingId === payment.id ? 'Verifying evidence…' : 'Verify evidence and query'}</button>}</div>}</div>)}</div>}
            {adminRole === 'SUPERADMIN' ? <>
            <label>Investigation note (10–500 characters)<textarea value={notes[payment.id] ?? ''} onChange={(event) => setNotes((current) => ({ ...current, [payment.id]: event.target.value }))} minLength={10} maxLength={500} placeholder="Record the reason for this reconciliation action." /></label>
            <small>{Math.min(notes[payment.id]?.trim().length ?? 0, 500)}/500 characters · At least 10 characters are required.</small>
            {payment.needsProviderIdentifiers && <div className="reconciliation-provider-identifiers">
              <p>Record the exact AccountReference and both IDs from official Safaricom records, plus its evidence source and case/reference. This records evidence only; a different Superadmin must verify it before LoanPlus queries Safaricom.</p>
              <label>Evidence source<select value={providerIdentifiers[payment.id]?.evidenceSource ?? ''} onChange={(event) => setProviderIdentifiers((current) => ({ ...current, [payment.id]: { accountReference: current[payment.id]?.accountReference ?? '', checkoutRequestId: current[payment.id]?.checkoutRequestId ?? '', merchantRequestId: current[payment.id]?.merchantRequestId ?? '', evidenceSource: event.target.value, evidenceReference: current[payment.id]?.evidenceReference ?? '' } }))} required><option value="">Select source</option><option value="SAFARICOM_PORTAL">Safaricom portal</option><option value="SAFARICOM_SUPPORT">Safaricom support</option></select></label>
              <label>Safaricom case/record reference<input value={providerIdentifiers[payment.id]?.evidenceReference ?? ''} onChange={(event) => setProviderIdentifiers((current) => ({ ...current, [payment.id]: { accountReference: current[payment.id]?.accountReference ?? '', checkoutRequestId: current[payment.id]?.checkoutRequestId ?? '', merchantRequestId: current[payment.id]?.merchantRequestId ?? '', evidenceSource: current[payment.id]?.evidenceSource ?? '', evidenceReference: event.target.value } }))} minLength={3} maxLength={100} autoComplete="off" /></label>
              <label>Safaricom AccountReference<input value={providerIdentifiers[payment.id]?.accountReference ?? ''} onChange={(event) => setProviderIdentifiers((current) => ({ ...current, [payment.id]: { ...current[payment.id], accountReference: event.target.value } }))} maxLength={12} autoComplete="off" /></label>
              <label>Safaricom checkout request ID<input value={providerIdentifiers[payment.id]?.checkoutRequestId ?? ''} onChange={(event) => setProviderIdentifiers((current) => ({ ...current, [payment.id]: { ...current[payment.id], checkoutRequestId: event.target.value } }))} maxLength={100} autoComplete="off" /></label>
              <label>Safaricom merchant request ID<input value={providerIdentifiers[payment.id]?.merchantRequestId ?? ''} onChange={(event) => setProviderIdentifiers((current) => ({ ...current, [payment.id]: { ...current[payment.id], merchantRequestId: event.target.value } }))} maxLength={100} autoComplete="off" /></label>
            </div>}
            {payment.reconciliationStatus === 'ESCALATED' && <p role="status">Escalated for provider investigation; wait for authoritative evidence before taking further action.</p>}
            <div className="reconciliation-actions">
              <button className="button" type="button" disabled={refreshingId !== null || escalatingId !== null || (notes[payment.id]?.trim().length ?? 0) < 10 || (payment.needsProviderIdentifiers && (!providerIdentifiers[payment.id]?.accountReference.trim() || !providerIdentifiers[payment.id]?.checkoutRequestId.trim() || !providerIdentifiers[payment.id]?.merchantRequestId.trim() || !providerIdentifiers[payment.id]?.evidenceSource || (providerIdentifiers[payment.id]?.evidenceReference.trim().length ?? 0) < 3))} onClick={() => void refreshPayment(payment)}>{refreshingId === payment.id ? payment.needsProviderIdentifiers ? 'Recording evidence…' : 'Checking provider status…' : payment.needsProviderIdentifiers ? 'Submit evidence for review' : 'Refresh provider status'}</button>
              <button className="quiet-button" type="button" disabled={refreshingId !== null || escalatingId !== null || (notes[payment.id]?.trim().length ?? 0) < 10 || payment.reasonForInclusion === 'ESCALATED'} onClick={() => void escalatePayment(payment)}>{payment.reasonForInclusion === 'ESCALATED' ? 'Already escalated' : escalatingId === payment.id ? 'Recording escalation…' : 'Escalate for investigation'}</button>
            </div>
            </> : adminRole ? <p role="status">Read-only reconciliation access. A Superadmin must submit provider queries, review evidence, or escalate this payment.</p> : null}
          </article>
        ))}
      </section>
      <nav className="reconciliation-pagination" aria-label="Reconciliation pages">
        <button className="quiet-button" type="button" disabled={!pageCursor || loading} onClick={() => void goToFirstPage()}>First page</button>
        <button className="quiet-button" type="button" disabled={cursorHistory.length === 0 || loading} onClick={() => void goToPreviousPage()}>Previous page</button>
        <button className="quiet-button" type="button" disabled={!nextCursor || loading} onClick={() => void goToNextPage()}>Next page</button>
      </nav>
    </main>
  );
}
