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
  processingFeePayments: Array<{ status: string; failureCode: string | null }>;
  loan: null | { status: string; disbursement: null | { amountKes: number; status: string } };
  product: { name: string };
}
interface LedgerEntry { id: string; debitKes: number; creditKes: number; createdAt: string; transaction: { internalReference: string; transactionType: string; status: string } }
interface PaymentAttempt { internalReference: string; type: string; amountKes: number; currency: string; status: string; createdAt: string; providerResult: { message: string } }
interface Product {
  id: string;
  name: string;
  description: string;
  minimumPrincipalKes: number;
  maximumPrincipalKes: number;
  durationDays: number;
  interestRateBps: number;
  flatFeeKes: number;
}

export default function DashboardPage() {
  const router = useRouter();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [applications, setApplications] = useState<LoanApplication[]>([]);
  const [recentEntries, setRecentEntries] = useState<LedgerEntry[]>([]);
  const [paymentAttempts, setPaymentAttempts] = useState<PaymentAttempt[]>([]);
  const [products, setProducts] = useState<Product[] | null>(null);
  const [productsLoading, setProductsLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const applicationStatus = (application: LoanApplication) => {
    if (application.status === 'DRAFT' || application.status === 'PROCESSING_PAYMENT_PENDING') {
      const latest = application.processingFeePayments[0];
      if (application.processingFeePayments.some((payment) =>
        payment.status === 'PENDING' || (payment.status === 'FAILED' && payment.failureCode === 'MPESA_RESULT_4999'),
      )) return 'Processing Payment Unresolved';
      if (latest?.status === 'CONFIRMED') return 'Payment Confirmed — Awaiting Review';
      if (latest?.status === 'FAILED') return 'Processing Payment Failed';
      if (latest?.status === 'PENDING') return 'Processing Payment Pending';
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

  async function refreshProducts() {
    setProductsLoading(true);
    try {
      setProducts((await apiRequest<Product[]>('/loans/products', { cache: 'no-store' })).slice(0, 3));
    } catch (reason) {
      setProducts(null);
      setError(reason instanceof Error ? reason.message : 'Available loan products could not be loaded.');
    } finally {
      setProductsLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function loadDashboard() {
      try {
        const profile = await apiRequest<Customer>('/auth/me', { cache: 'no-store' });
        if (cancelled) return;
        setCustomer(profile);
        const [walletResult, applicationsResult, entriesResult, paymentsResult, productsResult] = await Promise.allSettled([
          apiRequest<Wallet>('/wallet', { cache: 'no-store' }),
          apiRequest<LoanApplication[]>('/loans/applications', { cache: 'no-store' }),
          apiRequest<LedgerEntry[]>('/wallet/transactions', { cache: 'no-store' }),
          apiRequest<PaymentAttempt[]>('/payments', { cache: 'no-store' }),
          apiRequest<Product[]>('/loans/products', { cache: 'no-store' }),
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
        if (productsResult.status === 'fulfilled') setProducts(productsResult.value.slice(0, 3));
        else {
          setProducts(null);
          setError((current) => current || 'Available loan products could not be loaded.');
        }
        setProductsLoading(false);
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
    <main className="dashboard-page dashboard-home">
      <header className="dashboard-top">
        <Link className="wordmark" href="/"><span className="brand-mark">L+</span> loanplus</Link>
        <Link className="quiet-button" href="/profile">My profile</Link>
      </header>
      <section className="dashboard-welcome dashboard-home-welcome">
        <p className="eyebrow">WELCOME TO LOANPLUS</p>
        <h1>Hello, {customer.fullName.trim().split(/\s+/)[0]}.</h1>
        <p>Your account at a glance.</p>
      </section>
      {error && <p className="form-error" role="alert">{error}</p>}
      <section className="dashboard-wallet-card" aria-label="Wallet balance">
        <div><span>Wallet balance</span><Link href="/wallet">View wallet <span aria-hidden="true">›</span></Link></div>
        <strong>{wallet ? formatKes(wallet.balanceKes) : 'Unavailable'}</strong>
        <small>{wallet ? wallet.currency : 'Balance could not be verified'}</small>
      </section>
      {!wallet && <p className="dashboard-retry"><Link href="/wallet">Open wallet to retry balance</Link></p>}
      <section className="dashboard-quick-actions" aria-label="Quick actions">
        <Link className="dashboard-action" href="/loans"><span aria-hidden="true">↗</span><b>Apply for a loan</b></Link>
        <button className="dashboard-action" type="button" disabled aria-label="Deposit unavailable: wallet deposits are not enabled"><span aria-hidden="true">＋</span><b>Deposit</b></button>
        <button className="dashboard-action" type="button" disabled aria-label="Send Money unavailable: internal transfers are not enabled"><span aria-hidden="true">⇄</span><b>Send Money</b></button>
        <button className="dashboard-action" type="button" disabled aria-label="Withdraw unavailable: payouts are not enabled"><span aria-hidden="true">↗</span><b>Withdraw</b></button>
        <p>Deposits, internal transfers, and withdrawals are not yet available.</p>
      </section>
      <section className="dashboard-products" aria-labelledby="dashboard-products-title">
        <div className="dashboard-section-heading"><h2 id="dashboard-products-title">Loan products</h2><Link href="/loans">View all <span aria-hidden="true">›</span></Link></div>
        {productsLoading ? <p className="dashboard-products-empty" role="status">Loading configured loan products…</p> : products === null ? <p className="dashboard-products-empty" role="alert">Loan products could not be loaded. <button className="quiet-button" type="button" onClick={() => void refreshProducts()}>Retry</button></p> : products.length === 0 ? <p className="dashboard-products-empty">No available loan products.</p> : products.map((item) => (
          <Link className="dashboard-product-row" href={`/loans?productId=${encodeURIComponent(item.id)}`} key={item.id}>
            <span className="dashboard-product-icon" aria-hidden="true">L+</span>
            <span className="dashboard-product-copy"><b>{item.name}</b><small>{item.description}</small><small>From {formatKes(item.minimumPrincipalKes)} to {formatKes(item.maximumPrincipalKes)} · {item.durationDays} days</small></span>
            <span className="dashboard-product-arrow" aria-hidden="true">›</span>
          </Link>
        ))}
      </section>
      <section className="dashboard-shortcuts" aria-label="More account services">
        <Link href="/transactions">Payments and activity <span aria-hidden="true">›</span></Link>
        <Link href="/referrals">Referral programme <span aria-hidden="true">›</span></Link>
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
    </main>
  );
}