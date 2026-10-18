'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiRequest } from '@/lib/api';
import { formatMoney as formatKes } from '@/lib/currency';

interface Customer { id: string; fullName: string; email: string; role: string; identityStatus: string; activationStatus: string }
interface Wallet { balanceKes: number; currency: string }
interface LoanApplication { id: string; requestedPrincipalKes: number; status: string; submittedAt: string; product: { name: string } }

export default function DashboardPage() {
  const router = useRouter();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [applications, setApplications] = useState<LoanApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function loadDashboard() {
      try {
        const profile = await apiRequest<Customer>('/auth/me', { cache: 'no-store' });
        if (cancelled) return;
        setCustomer(profile);
        const [walletResult, applicationsResult] = await Promise.allSettled([
          apiRequest<Wallet>('/wallet', { cache: 'no-store' }),
          apiRequest<LoanApplication[]>('/loans/applications', { cache: 'no-store' }),
        ]);
        if (cancelled) return;
        if (walletResult.status === 'fulfilled') setWallet(walletResult.value);
        else setError('Your wallet balance could not be refreshed.');
        if (applicationsResult.status === 'fulfilled') setApplications(applicationsResult.value);
        else setError((current) => current || 'Loan application status could not be loaded.');
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
  if (!wallet) return <main className="dashboard-loading"><p role="alert">The wallet balance is unavailable; no balance is displayed.</p><Link className="button" href="/wallet">Retry wallet load</Link></main>;
  return <main className="dashboard-page"><header className="dashboard-top"><Link className="wordmark" href="/"><span className="brand-mark">L+</span> loanplus</Link><Link className="quiet-button" href="/profile">My profile</Link></header><section className="dashboard-welcome"><p className="eyebrow">CUSTOMER ACCOUNT</p><h1>Hello, {customer.fullName.split(' ')[0]}.</h1><p>{customer.activationStatus === 'ACTIVE' ? 'Your account is active. Loan applications remain subject to eligibility and manual review.' : 'Your account is not yet activated. Review the current payment state before requesting a prompt.'}</p></section><section className="account-status"><h2>Account overview</h2><dl><div><dt>Wallet balance</dt><dd>{formatKes(wallet.balanceKes)}</dd></div><div><dt>Email</dt><dd>{customer.email}</dd></div><div><dt>Activation</dt><dd><span className="status-label">{customer.activationStatus.replaceAll('_', ' ')}</span></dd></div><div><dt>Identity status</dt><dd><span className="status-label">{customer.identityStatus.replaceAll('_', ' ')}</span></dd></div><div><dt>National ID</dt><dd>Protected · ID document not collected</dd></div></dl>{customer.activationStatus !== 'ACTIVE' && <Link className="button dashboard-activate" href="/activation">Review activation <span aria-hidden="true">↗</span></Link>}</section><section className="dashboard-empty"><p className="eyebrow">YOUR LOAN APPLICATIONS</p>{applications.length ? <div className="application-list">{applications.map((application) => <article key={application.id}><div><b>{application.product.name}</b><small>{new Date(application.submittedAt).toLocaleDateString('en-KE')}</small></div><span>{formatKes(application.requestedPrincipalKes)}</span><span className="status-label">{application.status.replaceAll('_', ' ')}</span></article>)}</div> : <><h2>No applications yet.</h2><p>Your applications and decisions will appear here. Products and terms are managed by LoanPlus.</p></>}<Link className="legal-home" href="/loans">View configured products ↗</Link></section><div className="dashboard-links"><Link href="/wallet">Wallet <span aria-hidden="true">↗</span></Link><Link href="/loans">Loan products <span aria-hidden="true">↗</span></Link><Link href="/transactions">Transactions <span aria-hidden="true">↗</span></Link><Link href="/referrals">Referral programme <span aria-hidden="true">↗</span></Link><Link href="/support">Customer support <span aria-hidden="true">↗</span></Link><Link href="/settings/security">Security settings <span aria-hidden="true">↗</span></Link></div></main>;
}