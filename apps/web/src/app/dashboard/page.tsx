'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiRequest } from '@/lib/api';
import { formatMoney as formatKes } from '@/lib/currency';

interface Customer { id: string; fullName: string; email: string; role: string; identityStatus: string }
interface Wallet { balanceKes: number; currency: string }
interface LoanApplication {
  id: string;
  requestedPrincipalKes: number;
  approvedPrincipalKes: number | null;
  status: string;
  submittedAt: string | null;
  processingFeePayment: null | { status: string; failureCode: string | null };
  loan: null | { status: string; disbursement: null | { amountKes: number; status: string } };
  product: { name: string };
}
interface LedgerEntry { id: string; debitKes: number; creditKes: number; createdAt: string; transaction: { internalReference: string; transactionType: string; status: string } }
interface PaymentAttempt { internalReference: string; type: string; amountKes: number; currency: string; status: string; createdAt: string; providerResult: { message: string } }

export default function DashboardPage() {
  const router = useRouter();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [applications, setApplications] = useState<LoanApplication[]>([]);
  const [recentEntries, setRecentEntries] = useState<LedgerEntry[]>([]);
  const [paymentAttempts, setPaymentAttempts] = useState<PaymentAttempt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const applicationStatus = (application: LoanApplication) => {
    if (application.status === 'DRAFT' || application.status === 'PROCESSING_PAYMENT_PENDING') {
      if (application.processingFeePayment?.failureCode) return 'Processing Payment Unresolved';
      if (application.processingFeePayment?.status === 'FAILED') return 'Processing Payment Failed';
      if (application.processingFeePayment?.status === 'PENDING') return 'Processing Payment Pending';
      if (application.status === 'PROCESSING_PAYMENT_PENDING') return 'Processing Payment Unresolved';
      return 'Draft — Processing Fee Required';
    }
    if (application.status === 'SUBMITTED') return 'Submitted — Awaiting Admin Review';
    if (application.status === 'UNDER_REVIEW') return 'Under Review';
    if (application.status === 'APPROVED') return 'Approved — Awaiting Offer Acceptance';
    if (application.status === 'ACCEPTED') {
      return application.loan?.status === 'DISBURSED' ? 'Disbursed' : 'Approved — Awaiting Disbursement';
    }
    return application.status.replaceAll('_', ' ');
  };

  useEffect(() => {
    let cancelled = false;
    async function loadDashboard() {
      try {
        const profile = await apiRequest<Customer>('/auth/me', { cache: 'no-store' });
        if (cancelled) return;
        setCustomer(profile);
        const [walletResult, applicationsResult, entriesResult, paymentsResult] = await Promise.allSettled([
          apiRequest<Wallet>('/wallet', { cache: 'no-store' }),
          apiRequest<LoanApplication[]>('/loans/applications', { cache: 'no-store' }),
          apiRequest<LedgerEntry[]>('/wallet/transactions', { cache: 'no-store' }),
          apiRequest<PaymentAttempt[]>('/payments', { cache: 'no-store' }),
        ]);
        if (cancelled) return;
        if (walletResult.status === 'fulfilled') setWallet(walletResult.value);
        else setError('Your wallet balance could not be refreshed.');
        if (applicationsResult.status === 'fulfilled') setApplications(applicationsResult.value);
        else setError((current) => current || 'Loan application status could not be loaded.');
        if (entriesResult.status === 'fulfilled') setRecentEntries(entriesResult.value.slice(0, 4));
        else setError((current) => current || 'Recent wallet activity could not be loaded.');
        if (paymentsResult.status === 'fulfilled') setPaymentAttempts(paymentsResult.value.slice(0, 3));
        else setError((current) => current || 'Payment status could not be loaded.');
      } catch (reason) {
        if (!cancelled && reason instanceof Error && reason.message.includes('Authentication required')) {
          router.replace('/login');
        } else if (!cancelled) {
          setError(reason instanceof Error ? reason.message : 'Your account could not be loaded.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadDashboard();
    return () => { cancelled = true; };
  }, [router]);

  if (loading) return <main className="dashboard-loading">Loading your account…</main>;
  if (!customer) return <main className="dashboard-loading">{error || 'Your account could not be loaded.'}</main>;
  return (
    <main className="dashboard-page">
      <header className="dashboard-top">
        <Link className="wordmark" href="/"><span className="brand-mark">L+</span> loanplus</Link>
        <Link className="quiet-button" href="/profile">My profile</Link>
      </header>
      <section className="dashboard-welcome">
        <p className="eyebrow">CUSTOMER ACCOUNT</p>
        <h1>Hello, {customer.fullName.split(' ')[0]}.</h1>
        <p>Your account is available without an activation fee. Loan applications require a KSh 50 processing fee and remain subject to eligibility and manual review.</p>
      </section>
      {error && <p className="form-error" role="alert">{error}</p>}
      <section className="account-status">
        <h2>Account overview</h2>
        <dl>
          <div><dt>Wallet balance</dt><dd>{wallet ? formatKes(wallet.balanceKes) : 'Unavailable'}</dd></div>
          <div><dt>Email</dt><dd>{customer.email}</dd></div>
          <div><dt>Identity status</dt><dd><span className="status-label">{customer.identityStatus.replaceAll('_', ' ')}</span></dd></div>
          <div><dt>National ID</dt><dd>Protected · ID document not collected</dd></div>
        </dl>
        {!wallet && <Link className="quiet-button" href="/wallet">Open wallet to retry balance</Link>}
        <Link className="button dashboard-activate" href="/loans">Apply for a loan <span aria-hidden="true">↗</span></Link>
      </section>
      {paymentAttempts.some((payment) => payment.status === 'PENDING') && (
        <section className="dashboard-empty" aria-live="polite">
          <p className="eyebrow">PAYMENT UPDATE</p>
          <h2>Payment confirmation is pending.</h2>
          <p>The payment outcome is still being verified. Do not submit another payment while this request remains unresolved.</p>
          <Link className="legal-home" href="/transactions">Review payment history ↗</Link>
        </section>
      )}
      <section className="dashboard-empty">
        <p className="eyebrow">YOUR LOAN APPLICATIONS</p>
        {applications.length ? <div className="application-list">{applications.map((application) => (
          <article key={application.id}>
            <div><b>{application.product.name}</b><small>Requested {formatKes(application.requestedPrincipalKes)}{application.submittedAt ? ` · Submitted ${new Date(application.submittedAt).toLocaleDateString('en-KE')}` : ' · Not submitted'}</small></div>
            <span>{application.approvedPrincipalKes === null ? 'Not approved' : `Approved ${formatKes(application.approvedPrincipalKes)}`}</span>
            <span className="status-label">{applicationStatus(application)}</span>
            {application.loan?.disbursement?.status === 'CONFIRMED' && <small>Disbursed {formatKes(application.loan.disbursement.amountKes)}</small>}
          </article>
        ))}</div> : <><h2>No applications yet.</h2><p>Your applications and decisions will appear here. Products and terms are managed by LoanPlus.</p></>}
        <Link className="legal-home" href="/loans">View configured products ↗</Link>
      </section>
      <section className="dashboard-empty" aria-label="Recent wallet activity">
        <p className="eyebrow">RECENT ACTIVITY</p>
        {recentEntries.length ? <div className="application-list">{recentEntries.map((entry) => {
          const incoming = entry.creditKes > 0;
          const amount = incoming ? entry.creditKes : entry.debitKes;
          return <article key={entry.id}>
            <div><b>{entry.transaction.transactionType.replaceAll('_', ' ')}</b><small>{entry.transaction.internalReference} · {new Date(entry.createdAt).toLocaleString('en-KE')}</small></div>
            <span>{incoming ? '+' : '−'}{formatKes(amount)}</span>
            <span className="status-label">{entry.transaction.status}</span>
          </article>;
        })}</div> : <><h2>No posted activity yet.</h2><p>Confirmed wallet activity will appear here.</p></>}
        <Link className="legal-home" href="/transactions">View all activity ↗</Link>
      </section>
      {paymentAttempts.length > 0 && <section className="dashboard-empty" aria-label="Recent payment attempts">
        <p className="eyebrow">PAYMENT ATTEMPTS</p>
        <div className="application-list">{paymentAttempts.map((payment) => (
          <article key={payment.internalReference}>
            <div><b>{payment.type.replaceAll('_', ' ')}</b><small>{payment.internalReference} · {new Date(payment.createdAt).toLocaleString('en-KE')}</small></div>
            <span>{formatKes(payment.amountKes)}</span>
            <span className="status-label">{payment.status}</span>
            {payment.status === 'PENDING' && <p>{payment.providerResult.message}</p>}
          </article>
        ))}</div>
        <Link className="legal-home" href="/transactions">View payment history ↗</Link>
      </section>}
      <div className="dashboard-links">
        <Link href="/wallet">Wallet <span aria-hidden="true">↗</span></Link>
        <Link href="/loans">Loan products <span aria-hidden="true">↗</span></Link>
        <Link href="/transactions">Transactions <span aria-hidden="true">↗</span></Link>
        <Link href="/referrals">Referral programme <span aria-hidden="true">↗</span></Link>
        <Link href="/support">Customer support <span aria-hidden="true">↗</span></Link>
        <Link href="/settings/security">Security settings <span aria-hidden="true">↗</span></Link>
      </div>
    </main>
  );
}