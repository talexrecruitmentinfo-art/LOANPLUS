'use client';

import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { apiRequest } from '@/lib/api';
import { formatMoney } from '@/lib/currency';

interface CustomerRecord {
  id: string;
  fullName: string;
  email: string;
  phoneMasked: string;
  role: string;
  identityStatus: string;
  isActive: boolean;
  createdAt: string;
  _count: { paymentTransactions: number; loans: number; loanApplications: number };
}

interface CustomerPage {
  items: CustomerRecord[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

interface CustomerDetail extends CustomerRecord {
  activationStatus: string;
  updatedAt: string;
  loanApplications: Array<{
    id: string;
    status: string;
    requestedPrincipalKes: number;
    approvedPrincipalKes: number | null;
    decisionReason: string | null;
    submittedAt: string | null;
    createdAt: string;
    product: { name: string };
    processingFeePayment: null | { internalReference: string; status: string; amountKes: number; receiptReference: string | null; confirmedAt: string | null };
  }>;
  loans: Array<{
    id: string;
    status: string;
    principalKes: number;
    outstandingKes: number;
    totalRepayableKes: number;
    disbursedAt: string | null;
    repaidAt: string | null;
    createdAt: string;
    repayments: Array<{ amountKes: number; createdAt: string; paymentTransaction: { internalReference: string } }>;
  }>;
  paymentTransactions: Array<{
    internalReference: string;
    type: string;
    amountKes: number;
    currency: string;
    status: string;
    providerReference: string | null;
    receiptReference: string | null;
    failureCode: string | null;
    createdAt: string;
    confirmedAt: string | null;
  }>;
  referralsSent: Array<{ id: string; status: string; createdAt: string; qualifiedAt: string | null; reward: null | { amountKes: number; status: string; createdAt: string } }>;
  supportTickets: Array<{ reference: string; subject: string; status: string; createdAt: string }>;
}

interface CustomerFilters {
  search: string;
  accountStatus: string;
  identityStatus: string;
  registeredFrom: string;
  registeredTo: string;
}

export default function AdminCustomersPage() {
  const router = useRouter();
  const [result, setResult] = useState<CustomerPage | null>(null);
  const [appliedFilters, setAppliedFilters] = useState<CustomerFilters>({
    search: '',
    accountStatus: 'ALL',
    identityStatus: 'ALL',
    registeredFrom: '',
    registeredTo: '',
  });
  const [search, setSearch] = useState('');
  const [accountStatus, setAccountStatus] = useState('ALL');
  const [identityStatus, setIdentityStatus] = useState('ALL');
  const [registeredFrom, setRegisteredFrom] = useState('');
  const [registeredTo, setRegisteredTo] = useState('');
  const [page, setPage] = useState(1);
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [customerDetail, setCustomerDetail] = useState<CustomerDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [detailNotice, setDetailNotice] = useState('');
  const [statusBusy, setStatusBusy] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [passwordResetBusy, setPasswordResetBusy] = useState(false);
  const listRequest = useRef(0);
  const detailRequest = useRef(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const requestId = ++listRequest.current;
    setLoading(true);
    setError('');
    const params = new URLSearchParams({ page: String(page), pageSize: '25' });
    if (appliedFilters.search.trim()) params.set('search', appliedFilters.search.trim());
    if (appliedFilters.accountStatus !== 'ALL') params.set('accountStatus', appliedFilters.accountStatus);
    if (appliedFilters.identityStatus !== 'ALL') params.set('identityStatus', appliedFilters.identityStatus);
    if (appliedFilters.registeredFrom) params.set('registeredFrom', appliedFilters.registeredFrom);
    if (appliedFilters.registeredTo) params.set('registeredTo', appliedFilters.registeredTo);
    try {
      const response = await apiRequest<CustomerPage>(`/admin/customers?${params.toString()}`, { cache: 'no-store' });
      if (requestId === listRequest.current) setResult(response);
    } catch (reason) {
      if (requestId === listRequest.current) {
        if (reason instanceof Error && reason.message.includes('Authentication required')) router.replace('/admin/login');
        setError(reason instanceof Error ? reason.message : 'Customer records could not be loaded.');
      }
    } finally {
      if (requestId === listRequest.current) setLoading(false);
    }
  }, [appliedFilters, page, router]);

  useEffect(() => { void refresh(); }, [refresh]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setAppliedFilters({ search, accountStatus, identityStatus, registeredFrom, registeredTo });
  }

  function clearFilters() {
    setSearch('');
    setAccountStatus('ALL');
    setIdentityStatus('ALL');
    setRegisteredFrom('');
    setRegisteredTo('');
    setPage(1);
    setAppliedFilters({ search: '', accountStatus: 'ALL', identityStatus: 'ALL', registeredFrom: '', registeredTo: '' });
  }

  async function toggleCustomerDetails(customerId: string) {
    if (selectedCustomerId === customerId) {
      detailRequest.current += 1;
      setSelectedCustomerId('');
      setCustomerDetail(null);
      setDetailError('');
      setDetailNotice('');
      return;
    }
    const requestId = ++detailRequest.current;
    setSelectedCustomerId(customerId);
    setCustomerDetail(null);
    setDetailError('');
    setDetailNotice('');
    setDetailLoading(true);
    try {
      const detail = await apiRequest<CustomerDetail>(`/admin/customers/${encodeURIComponent(customerId)}`, { cache: 'no-store' });
      if (requestId === detailRequest.current) setCustomerDetail(detail);
    } catch (reason) {
      if (requestId === detailRequest.current) {
        if (reason instanceof Error && reason.message.includes('Authentication required')) router.replace('/admin/login');
        setDetailError(reason instanceof Error ? reason.message : 'Customer details could not be loaded.');
      }
    } finally {
      if (requestId === detailRequest.current) setDetailLoading(false);
    }
  }

  async function updateCustomerStatus(event: FormEvent<HTMLFormElement>, customer: CustomerDetail) {
    event.preventDefault();
    const nextStatus = !customer.isActive;
    const action = nextStatus ? 'reactivate' : 'suspend';
    if (!window.confirm(`Confirm ${action} for ${customer.fullName}? All existing customer sessions will be revoked.`)) return;
    setStatusBusy(true);
    setDetailError('');
    setDetailNotice('');
    try {
      const result = await apiRequest<{ id: string; isActive: boolean; changed: boolean }>(`/admin/customers/${encodeURIComponent(customer.id)}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: nextStatus, reason: new FormData(event.currentTarget).get('reason') }),
      });
      setCustomerDetail((current) => current?.id === result.id ? { ...current, isActive: result.isActive } : current);
      setDetailNotice(result.changed ? `Customer account ${nextStatus ? 'reactivated' : 'suspended'} and audited.` : 'Account was already in the selected state.');
      await refresh();
    } catch (reason) {
      setDetailError(reason instanceof Error ? reason.message : 'Customer account status could not be changed.');
    } finally {
      setStatusBusy(false);
    }
  }

  async function updateCustomerProfile(event: FormEvent<HTMLFormElement>, customer: CustomerDetail) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setProfileBusy(true);
    setDetailError('');
    setDetailNotice('');
    try {
      const updated = await apiRequest<{ id: string; fullName: string; updatedAt: string; changed: boolean }>(
        `/admin/customers/${encodeURIComponent(customer.id)}/profile`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            fullName: values.get('fullName'),
            expectedUpdatedAt: customer.updatedAt,
            reason: values.get('profileReason'),
          }),
        },
      );
      setCustomerDetail((current) => current?.id === updated.id
        ? { ...current, fullName: updated.fullName, updatedAt: updated.updatedAt }
        : current);
      setDetailNotice(updated.changed ? 'Customer display name updated and audited.' : 'No profile changes were needed.');
      await refresh();
    } catch (reason) {
      setDetailError(reason instanceof Error ? reason.message : 'Customer profile could not be updated.');
    } finally {
      setProfileBusy(false);
    }
  }

  async function requestPasswordReset(event: FormEvent<HTMLFormElement>, customer: CustomerDetail) {
    event.preventDefault();
    if (!window.confirm(`Send a one-time password reset link to ${customer.email}? The link will not be shown here.`)) return;
    const form = event.currentTarget;
    setPasswordResetBusy(true);
    setDetailError('');
    setDetailNotice('');
    try {
      const result = await apiRequest<{ requested: boolean; delivery: 'SENT' | 'UNAVAILABLE' }>(
        `/admin/customers/${encodeURIComponent(customer.id)}/password-reset`,
        {
          method: 'POST',
          body: JSON.stringify({ reason: new FormData(form).get('resetReason') }),
        },
      );
      setDetailNotice(result.delivery === 'SENT'
        ? 'Reset instructions were sent to the registered email. The reset link is not available to Admins.'
        : 'Email delivery is unavailable. No usable reset link was sent; check the configured mail service before trying again.');
      form.reset();
    } catch (reason) {
      setDetailError(reason instanceof Error ? reason.message : 'Password-reset instructions could not be requested.');
    } finally {
      setPasswordResetBusy(false);
    }
  }

  const customers = result?.items ?? [];
  return (
    <main className="dashboard-page admin-customers-page">
      <section className="dashboard-welcome">
        <p className="eyebrow">CUSTOMER MANAGEMENT</p>
        <h1>Customer accounts.</h1>
        <p>Search and review account activity. Sensitive identity values, authentication data and raw payment payloads are excluded.</p>
      </section>
      <form className="admin-payment-filters admin-customer-filters" onSubmit={submit}>
        <label>Search name, email or customer ID<input value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <label>Account status<select value={accountStatus} onChange={(event) => setAccountStatus(event.target.value)}><option value="ALL">All accounts</option><option value="ACTIVE">Enabled</option><option value="DISABLED">Disabled</option></select></label>
        <label>Identity review<select value={identityStatus} onChange={(event) => setIdentityStatus(event.target.value)}><option value="ALL">All statuses</option><option value="NOT_STARTED">Not started</option><option value="PENDING">Pending</option><option value="NEEDS_REVIEW">Needs review</option><option value="VERIFIED">Verified</option><option value="REJECTED">Rejected</option></select></label>
        <label>Registered from<input type="date" value={registeredFrom} onChange={(event) => setRegisteredFrom(event.target.value)} /></label>
        <label>Registered to<input type="date" value={registeredTo} onChange={(event) => setRegisteredTo(event.target.value)} /></label>
        <div className="admin-filter-actions"><button className="button button-small" type="submit">Apply filters</button><button className="quiet-button" type="button" onClick={clearFilters}>Clear</button><button className="quiet-button" type="button" onClick={() => void refresh()}>Refresh</button></div>
      </form>
      {error && <p className="admin-inline-error" role="alert">{error}</p>}
      <div className="admin-page-controls" aria-live="polite">
        <span>{loading ? 'Loading accounts…' : result ? `${result.total.toLocaleString()} accounts · page ${result.page} of ${Math.max(result.pageCount, 1)}` : 'Customer list unavailable'}</span>
      </div>
      <section className="admin-table-wrap" aria-live="polite">
        <table className="admin-data-table">
          <thead><tr><th>Customer</th><th>Account</th><th>Identity</th><th>Applications</th><th>Loans</th><th>Payments</th><th>Registered</th><th>Details</th></tr></thead>
          <tbody>
            {loading && <tr><td colSpan={8}>Loading customer records…</td></tr>}
            {!loading && customers.length === 0 && <tr><td colSpan={8} className="empty-copy">No matching customer records.</td></tr>}
            {!loading && customers.map((customer) => (
              <Fragment key={customer.id}>
              <tr>
                <td><b>{customer.fullName}</b><small>{customer.email}</small><small>{customer.phoneMasked}</small><small>Ref {customer.id}</small></td>
                <td><span className={`status-label ${customer.isActive ? '' : 'status-failed'}`}>{customer.isActive ? 'Enabled' : 'Disabled'}</span></td>
                <td>{customer.identityStatus.replaceAll('_', ' ')}</td>
                <td>{customer._count.loanApplications}</td>
                <td>{customer._count.loans}</td>
                <td>{customer._count.paymentTransactions}</td>
                <td>{new Date(customer.createdAt).toLocaleDateString('en-KE')}</td>
                <td><button type="button" aria-expanded={selectedCustomerId === customer.id} onClick={() => void toggleCustomerDetails(customer.id)}>{selectedCustomerId === customer.id ? 'Close' : 'View details'}</button></td>
              </tr>
              {selectedCustomerId === customer.id && <tr><td colSpan={8}>
                {detailLoading && <p>Loading customer details…</p>}
                {detailError && <p className="admin-inline-error" role="alert">{detailError}</p>}
                {detailNotice && <p className="admin-inline-notice" role="status">{detailNotice}</p>}
                {customerDetail?.id === customer.id && <div className="admin-customer-detail">
                  <section><h2>Account overview</h2><dl className="admin-customer-detail-grid"><div><dt>Customer ID</dt><dd>{customerDetail.id}</dd></div><div><dt>Email</dt><dd>{customerDetail.email} · read-only (no verified-change workflow)</dd></div><div><dt>Account status</dt><dd>{customerDetail.isActive ? 'Enabled' : 'Disabled'} · {customerDetail.activationStatus}</dd></div><div><dt>Identity review</dt><dd>{customerDetail.identityStatus.replaceAll('_', ' ')}</dd></div><div><dt>Role</dt><dd>{customerDetail.role}</dd></div><div><dt>Registered</dt><dd>{new Date(customerDetail.createdAt).toLocaleString('en-KE')}</dd></div><div><dt>Updated</dt><dd>{new Date(customerDetail.updatedAt).toLocaleString('en-KE')}</dd></div><div><dt>Recent record limits</dt><dd>Up to 20 per section</dd></div></dl>
                    <form className="admin-status-action" onSubmit={(event) => void updateCustomerProfile(event, customerDetail)}><h3>Edit permitted profile field</h3><label>Customer display name<input name="fullName" defaultValue={customerDetail.fullName} minLength={2} maxLength={160} required /></label><label>Reason<textarea name="profileReason" minLength={10} maxLength={500} rows={2} required /></label><button className="quiet-button" type="submit" disabled={profileBusy}>{profileBusy ? 'Saving…' : 'Save display name'}</button></form>
                    <form className="admin-status-action" onSubmit={(event) => void updateCustomerStatus(event, customerDetail)}><label>Reason for {customerDetail.isActive ? 'suspension' : 'reactivation'}<textarea name="reason" minLength={10} maxLength={500} rows={2} required /></label><button className="button button-small" type="submit" disabled={statusBusy}>{statusBusy ? 'Saving…' : customerDetail.isActive ? 'Suspend account' : 'Reactivate account'}</button></form>
                    <form className="admin-status-action" onSubmit={(event) => void requestPasswordReset(event, customerDetail)}><h3>Secure password reset</h3><p>A one-time link is sent to the registered address and is never shown to Admins.</p><label>Reason<textarea name="resetReason" minLength={10} maxLength={500} rows={2} required /></label><button className="quiet-button" type="submit" disabled={passwordResetBusy || !customerDetail.isActive}>{passwordResetBusy ? 'Requesting…' : 'Send reset instructions'}</button>{!customerDetail.isActive && <small>Reactivate the account before requesting a password reset.</small>}</form>
                  </section>
                  <section><h2>Loan applications</h2>{customerDetail.loanApplications.length ? customerDetail.loanApplications.map((application) => <article key={application.id}><b>{application.product.name} · {application.status.replaceAll('_', ' ')}</b><small>Requested {formatMoney(application.requestedPrincipalKes)}{application.approvedPrincipalKes !== null ? ` · Approved ${formatMoney(application.approvedPrincipalKes)}` : ''} · {new Date(application.createdAt).toLocaleDateString('en-KE')}</small>{application.processingFeePayment && <small>Fee {application.processingFeePayment.status} · {application.processingFeePayment.internalReference} · receipt {application.processingFeePayment.receiptReference ?? 'not verified'}</small>}{application.decisionReason && <small>Decision reason: {application.decisionReason}</small>}</article>) : <p className="empty-copy">No loan applications recorded.</p>}</section>
                  <section><h2>Loans &amp; repayments</h2>{customerDetail.loans.length ? customerDetail.loans.map((loan) => <article key={loan.id}><b>{loan.status.replaceAll('_', ' ')} · {formatMoney(loan.principalKes)} principal</b><small>Outstanding {formatMoney(loan.outstandingKes)} · total repayable {formatMoney(loan.totalRepayableKes)} · disbursed {loan.disbursedAt ? new Date(loan.disbursedAt).toLocaleDateString('en-KE') : 'not disbursed'}</small>{loan.repayments.map((repayment) => <small key={repayment.paymentTransaction.internalReference}>Repayment {formatMoney(repayment.amountKes)} · {repayment.paymentTransaction.internalReference} · {new Date(repayment.createdAt).toLocaleDateString('en-KE')}</small>)}</article>) : <p className="empty-copy">No loan records.</p>}</section>
                  <section><h2>Payments</h2>{customerDetail.paymentTransactions.length ? customerDetail.paymentTransactions.map((payment) => <article key={payment.internalReference}><b>{payment.type.replaceAll('_', ' ')} · {formatMoney(payment.amountKes)} {payment.currency} · {payment.status}</b><small>{payment.internalReference} · {new Date(payment.createdAt).toLocaleString('en-KE')}{payment.receiptReference ? ` · receipt ${payment.receiptReference}` : ''}</small>{payment.failureCode === 'MPESA_RESULT_4999' && <small>Legacy 4999 outcome is unresolved and not a verified failure.</small>}</article>) : <p className="empty-copy">No payment records.</p>}</section>
                  <section><h2>Referrals &amp; rewards</h2>{customerDetail.referralsSent.length ? customerDetail.referralsSent.map((referral) => <article key={referral.id}><b>{referral.status.replaceAll('_', ' ')}</b><small>Created {new Date(referral.createdAt).toLocaleDateString('en-KE')}{referral.reward ? ` · ${referral.reward.status} reward (${formatMoney(referral.reward.amountKes)})` : ''}</small></article>) : <p className="empty-copy">No referral records.</p>}</section>
                  <section><h2>Support tickets</h2>{customerDetail.supportTickets.length ? customerDetail.supportTickets.map((ticket) => <article key={ticket.reference}><b>{ticket.reference} · {ticket.status.replaceAll('_', ' ')}</b><small>{ticket.subject} · {new Date(ticket.createdAt).toLocaleDateString('en-KE')}</small></article>) : <p className="empty-copy">No support tickets.</p>}</section>
                </div>}
              </td></tr>}
              </Fragment>
            ))}
          </tbody>
        </table>
      </section>
      <div className="admin-page-controls">
        <span>{result ? `Showing ${customers.length} of ${result.total}` : ''}</span>
        <div><button type="button" disabled={loading || page <= 1} onClick={() => setPage((current) => current - 1)}>Previous</button><button type="button" disabled={loading || !result || page >= result.pageCount} onClick={() => setPage((current) => current + 1)}>Next</button></div>
      </div>
    </main>
  );
}
