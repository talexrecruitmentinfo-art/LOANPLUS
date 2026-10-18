'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiRequest } from '@/lib/api';
import { formatMoney } from '@/lib/currency';

interface MonitoredPayment {
  internalReference: string;
  type: string;
  amountKes: number;
  currency: string;
  status: string;
  providerReference: string | null;
  receiptReference: string | null;
  failureCode: string | null;
  confirmedAt: string | null;
  createdAt: string;
  user: { fullName: string; email: string };
  activationRequest: null | {
    checkoutRequestId: string | null;
    merchantRequestId: string | null;
    callbackEvents: Array<{ providerResultCode: string | null; providerReceiptReference: string | null; receivedAt: string }>;
  };
}

export default function AdminPaymentsPage() {
  const router = useRouter();
  const [payments, setPayments] = useState<MonitoredPayment[]>([]);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('ALL');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async (searchTerm = query, statusFilter = status) => {
    setLoading(true);
    setError('');
    const params = new URLSearchParams();
    if (searchTerm.trim()) params.set('search', searchTerm.trim());
    if (statusFilter !== 'ALL') params.set('status', statusFilter);
    try {
      setPayments(await apiRequest<MonitoredPayment[]>(`/admin/payments?${params.toString()}`, { cache: 'no-store' }));
    } catch (reason) {
      if (reason instanceof Error && reason.message.includes('Authentication required')) router.replace('/admin/login');
      setError(reason instanceof Error ? reason.message : 'Payment records could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [query, router, status]);

  useEffect(() => { void refresh('', 'ALL'); }, [refresh]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQuery(search);
    void refresh(search, status);
  }

  return (
    <main className="dashboard-page admin-payments-page">
      <header className="dashboard-top"><Link className="wordmark" href="/admin"><span className="brand-mark">L+</span> loanplus <span className="admin-tag">ADMIN</span></Link><Link className="quiet-button" href="/admin">Overview</Link></header>
      <section className="dashboard-welcome"><p className="eyebrow">PAYMENT MONITORING</p><h1>Payment records.</h1><p>Provider identifiers and callback outcomes are shown without raw provider payloads. Pending results are not settled funds.</p><Link className="legal-home" href="/admin/reconciliation">Open unresolved-payment queue ↗</Link></section>
      <form className="admin-payment-filters" onSubmit={submit}>
        <label>Reference, receipt or result<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search payment records" /></label>
        <label>Status<select value={status} onChange={(event) => { setStatus(event.target.value); void refresh(query, event.target.value); }}>
          <option value="ALL">All statuses</option><option value="PENDING">Pending</option><option value="CONFIRMED">Confirmed</option><option value="FAILED">Failed</option><option value="CANCELLED">Cancelled</option><option value="EXPIRED">Expired</option><option value="REVERSED">Reversed</option>
        </select></label>
        <button className="button button-small" type="submit">Search</button>
        <button className="quiet-button" type="button" onClick={() => void refresh()}>Refresh</button>
      </form>
      {error && <p className="admin-inline-error" role="alert">{error}</p>}
      <section className="admin-payment-list" aria-live="polite">
        {loading ? <p>Loading payment records…</p> : payments.length === 0 ? <p className="empty-copy">No matching payment records.</p> : payments.map((payment) => {
          const unresolvedLegacy = payment.status === 'FAILED' && payment.failureCode === 'MPESA_RESULT_4999';
          return (
            <article key={payment.internalReference}>
              <div className="admin-payment-heading"><div><b>{payment.user.fullName}</b><small>{payment.user.email}</small></div><span className={`status-label status-${unresolvedLegacy ? 'pending' : payment.status.toLowerCase()}`}>{unresolvedLegacy ? 'PENDING · LEGACY 4999' : payment.status}</span></div>
              <dl><div><dt>Payment</dt><dd>{payment.type} · {formatMoney(payment.amountKes)} {payment.currency}</dd></div><div><dt>Internal reference</dt><dd>{payment.internalReference}</dd></div><div><dt>Checkout ID</dt><dd>{payment.activationRequest?.checkoutRequestId ?? 'Not recorded'}</dd></div><div><dt>Merchant ID</dt><dd>{payment.activationRequest?.merchantRequestId ?? 'Not recorded'}</dd></div><div><dt>Provider reference</dt><dd>{payment.providerReference ?? 'Not recorded'}</dd></div><div><dt>Receipt</dt><dd>{payment.receiptReference ?? 'Not verified'}</dd></div><div><dt>Stored result</dt><dd>{payment.failureCode ?? 'None'}</dd></div><div><dt>Created</dt><dd>{new Date(payment.createdAt).toLocaleString('en-KE')}</dd></div></dl>
              <div className="admin-callback-history"><b>Callback history</b>{payment.activationRequest?.callbackEvents.length ? payment.activationRequest.callbackEvents.map((event, index) => <small key={`${event.receivedAt}-${index}`}>Result {event.providerResultCode ?? 'unknown'} · receipt {event.providerReceiptReference ? 'recorded' : 'not present'} · {new Date(event.receivedAt).toLocaleString('en-KE')}</small>) : <small>No callback event recorded.</small>}</div>
              {unresolvedLegacy && <p className="settings-copy">This row stores FAILED / MPESA_RESULT_4999 from the previous implementation. It is unresolved, not a verified failure; confirm the provider outcome before retrying.</p>}
            </article>
          );
        })}
      </section>
    </main>
  );
}