'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
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
  ledgerTransaction: null | { internalReference: string; transactionType: string; status: string };
  settlementIssues: string[];
}

interface PaymentPage {
  items: MonitoredPayment[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export default function AdminPaymentsPage() {
  const router = useRouter();
  const [result, setResult] = useState<PaymentPage | null>(null);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('ALL');
  const [type, setType] = useState('ALL');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const requestSequence = useRef(0);

  const refresh = useCallback(async (
    searchTerm: string,
    statusFilter: string,
    typeFilter: string,
    startDate: string,
    endDate: string,
    pageNumber: number,
  ) => {
    const requestId = ++requestSequence.current;
    setLoading(true);
    setError('');
    const params = new URLSearchParams({ page: String(pageNumber), pageSize: '25' });
    if (searchTerm.trim()) params.set('search', searchTerm.trim());
    if (statusFilter !== 'ALL') params.set('status', statusFilter);
    if (typeFilter !== 'ALL') params.set('type', typeFilter);
    if (startDate) params.set('from', startDate);
    if (endDate) params.set('to', endDate);
    try {
      const response = await apiRequest<PaymentPage>(`/admin/payments?${params.toString()}`, { cache: 'no-store' });
      if (requestId === requestSequence.current) setResult(response);
    } catch (reason) {
      if (requestId === requestSequence.current) {
        if (reason instanceof Error && reason.message.includes('Authentication required')) router.replace('/admin/login');
        setError(reason instanceof Error ? reason.message : 'Payment records could not be loaded.');
      }
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }, [router]);

  useEffect(() => { void refresh('', 'ALL', 'ALL', '', '', 1); }, [refresh]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQuery(search);
    setPage(1);
    void refresh(search, status, type, from, to, 1);
  }

  function selectStatus(value: string) {
    setStatus(value);
    setPage(1);
    void refresh(query, value, type, from, to, 1);
  }

  function selectType(value: string) {
    setType(value);
    setPage(1);
    void refresh(query, status, value, from, to, 1);
  }

  const payments = result?.items ?? [];
  return (
    <main className="dashboard-page admin-payments-page">
      <section className="dashboard-welcome">
        <p className="eyebrow">PAYMENT MONITORING</p>
        <h1>Payment records.</h1>
        <p>Provider identifiers and callback outcomes are shown without raw provider payloads. STK acceptance and pending results are not settled funds.</p>
      </section>
      <div className="admin-payment-context"><Link className="legal-home" href="/admin/reconciliation">Open unresolved-payment queue ↗</Link></div>
      <form className="admin-payment-filters" onSubmit={submit}>
        <label>Reference, customer or receipt<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search payment records" /></label>
        <label>Status<select value={status} onChange={(event) => selectStatus(event.target.value)}>
          <option value="ALL">All statuses</option><option value="PENDING">Pending / unresolved</option><option value="CONFIRMED">Confirmed</option><option value="FAILED">Failed</option><option value="CANCELLED">Cancelled</option><option value="EXPIRED">Expired</option><option value="REVERSED">Reversed</option>
        </select></label>
        <label>Payment type<select value={type} onChange={(event) => selectType(event.target.value)}>
          <option value="ALL">All payment types</option><option value="ACTIVATION">Historical activation</option><option value="LOAN_PROCESSING_FEE">Loan processing fee</option><option value="WALLET_DEPOSIT">Wallet deposit</option><option value="REPAYMENT">Repayment</option><option value="DISBURSEMENT">Disbursement</option><option value="WITHDRAWAL">Withdrawal</option><option value="REFUND">Refund</option>
        </select></label>
        <label>From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label>To<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
        <div className="admin-filter-actions"><button className="button button-small" type="submit">Apply filters</button><button className="quiet-button" type="button" onClick={() => void refresh(query, status, type, from, to, page)}>Refresh</button></div>
      </form>
      {error && <p className="admin-inline-error" role="alert">{error}</p>}
      <div className="admin-page-controls" aria-live="polite">
        <span>{loading ? 'Loading payment records…' : result ? `${result.total.toLocaleString()} records · page ${result.page} of ${Math.max(result.pageCount, 1)}` : 'Payment records unavailable'}</span>
      </div>
      <section className="admin-table-wrap" aria-live="polite">
        <table className="admin-data-table">
          <thead><tr><th>Customer</th><th>Type</th><th>Amount</th><th>Reference</th><th>Provider reference</th><th>Status</th><th>Created</th><th>Details</th></tr></thead>
          <tbody>
            {loading && <tr><td colSpan={8}>Loading payment records…</td></tr>}
            {!loading && payments.length === 0 && <tr><td colSpan={8} className="empty-copy">No matching payment records.</td></tr>}
            {!loading && payments.map((payment) => {
              const unresolvedLegacy = payment.status === 'FAILED' && payment.failureCode === 'MPESA_RESULT_4999';
              const paymentType = payment.type === 'ACTIVATION' ? 'Historical activation' : payment.type.replaceAll('_', ' ');
              return (
                <tr key={payment.internalReference}>
                  <td><b>{payment.user.fullName}</b><small>{payment.user.email}</small></td>
                  <td>{paymentType}</td>
                  <td>{formatMoney(payment.amountKes)} {payment.currency}</td>
                  <td><code>{payment.internalReference}</code></td>
                  <td>{payment.providerReference ?? '—'}</td>
                  <td><span className={`status-label status-${unresolvedLegacy ? 'pending' : payment.status.toLowerCase()}`}>{unresolvedLegacy ? 'UNRESOLVED · 4999' : payment.status}</span></td>
                  <td>{new Date(payment.createdAt).toLocaleString('en-KE')}</td>
                  <td>
                    <details>
                      <summary>Details</summary>
                      <div>
                        <dl><div><dt>Customer</dt><dd>{payment.user.fullName} · {payment.user.email}</dd></div><div><dt>Internal reference</dt><dd>{payment.internalReference}</dd></div><div><dt>Checkout ID</dt><dd>{payment.activationRequest?.checkoutRequestId ?? 'Not recorded'}</dd></div><div><dt>Merchant ID</dt><dd>{payment.activationRequest?.merchantRequestId ?? 'Not recorded'}</dd></div><div><dt>Provider reference</dt><dd>{payment.providerReference ?? 'Not recorded'}</dd></div><div><dt>Verified receipt</dt><dd>{payment.receiptReference ?? 'Not verified'}</dd></div><div><dt>Ledger journal</dt><dd>{payment.ledgerTransaction ? `${payment.ledgerTransaction.internalReference} · ${payment.ledgerTransaction.status}` : 'Not posted'}</dd></div><div><dt>Stored result</dt><dd>{payment.failureCode ?? 'None'}</dd></div><div><dt>Confirmed at</dt><dd>{payment.confirmedAt ? new Date(payment.confirmedAt).toLocaleString('en-KE') : 'Not confirmed'}</dd></div></dl>
                        <div className="admin-callback-history"><b>Settlement review</b>{payment.settlementIssues.length ? payment.settlementIssues.map((issue) => <small key={issue}>{issue.replaceAll('_', ' ')}</small>) : <small>No settlement exceptions detected.</small>}</div>
                        <div className="admin-callback-history"><b>Callback history</b>{payment.activationRequest?.callbackEvents.length ? payment.activationRequest.callbackEvents.map((event, index) => <small key={`${event.receivedAt}-${index}`}>Result {event.providerResultCode ?? 'unknown'} · receipt {event.providerReceiptReference ? 'recorded' : 'not present'} · {new Date(event.receivedAt).toLocaleString('en-KE')}</small>) : <small>No callback event recorded.</small>}</div>
                        {unresolvedLegacy && <p className="settings-copy">This historical FAILED / MPESA_RESULT_4999 record is unresolved, not a verified failure. Confirm the provider outcome before any retry.</p>}
                      </div>
                    </details>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      <div className="admin-page-controls">
        <span>{result ? `Showing ${payments.length} of ${result.total}` : ''}</span>
        <div><button type="button" disabled={loading || page <= 1} onClick={() => { const next = page - 1; setPage(next); void refresh(query, status, type, from, to, next); }}>Previous</button><button type="button" disabled={loading || !result || page >= result.pageCount} onClick={() => { const next = page + 1; setPage(next); void refresh(query, status, type, from, to, next); }}>Next</button></div>
      </div>
    </main>
  );
}
