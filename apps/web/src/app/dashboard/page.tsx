'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiRequest } from '@/lib/api';

interface Customer { id: string; fullName: string; email: string; role: string; identityStatus: string; activationStatus: string }
interface Wallet { balanceKes: number; currency: string }
interface LoanApplication { id: string; requestedPrincipalKes: number; status: string; submittedAt: string; product: { name: string } }

const formatKes = (amount: number) => `KSh ${new Intl.NumberFormat('en-KE').format(amount)}`;

export default function DashboardPage() {
  const router = useRouter();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [applications, setApplications] = useState<LoanApplication[]>([]);

  useEffect(() => {
    apiRequest<Customer>('/auth/me').then(async (profile) => {
      setCustomer(profile);
      const [currentWallet, currentApplications] = await Promise.all([
        apiRequest<Wallet>('/wallet'),
        apiRequest<LoanApplication[]>('/loans/applications'),
      ]);
      setWallet(currentWallet);
      setApplications(currentApplications);
    }).catch(() => router.replace('/login'));
  }, [router]);

  async function logout() {
    try { await apiRequest('/auth/logout', { method: 'POST', body: '{}' }); } finally { router.replace('/login'); }
  }

  if (!customer || !wallet) return <main className="dashboard-loading">Loading your account…</main>;
  return <main className="dashboard-page"><header className="dashboard-top"><Link className="wordmark" href="/"><span className="brand-mark">L+</span> loanplus</Link><button className="quiet-button" onClick={logout}>Log out</button></header><section className="dashboard-welcome"><p className="eyebrow">CUSTOMER ACCOUNT</p><h1>Hello, {customer.fullName.split(' ')[0]}.</h1><p>Your account is active. Loan applications require confirmed activation and manual review.</p></section><section className="account-status"><h2>Account overview</h2><dl><div><dt>Wallet balance</dt><dd>{formatKes(wallet.balanceKes)}</dd></div><div><dt>Email</dt><dd>{customer.email}</dd></div><div><dt>Activation</dt><dd><span className="status-label">{customer.activationStatus.replaceAll('_', ' ')}</span></dd></div><div><dt>Identity status</dt><dd><span className="status-label">{customer.identityStatus.replaceAll('_', ' ')}</span></dd></div><div><dt>National ID</dt><dd>Protected · ID document not collected</dd></div></dl>{customer.activationStatus !== 'ACTIVE' && <Link className="button dashboard-activate" href="/activation">Review activation <span aria-hidden="true">↗</span></Link>}</section><section className="dashboard-empty"><p className="eyebrow">YOUR LOAN APPLICATIONS</p>{applications.length ? <div className="application-list">{applications.map((application) => <article key={application.id}><div><b>{application.product.name}</b><small>{new Date(application.submittedAt).toLocaleDateString('en-KE')}</small></div><span>{formatKes(application.requestedPrincipalKes)}</span><span className="status-label">{application.status.replaceAll('_', ' ')}</span></article>)}</div> : <><h2>No applications yet.</h2><p>Your applications and decisions will appear here. Products and terms are managed by LoanPlus.</p></>}<Link className="legal-home" href="/loans">View configured products ↗</Link></section><div className="dashboard-links"><Link href="/activation">Account activation <span aria-hidden="true">↗</span></Link><Link href="/referrals">Referral programme <span aria-hidden="true">↗</span></Link><Link href="/support">Customer support <span aria-hidden="true">↗</span></Link><Link href="/settings/security">Security settings <span aria-hidden="true">↗</span></Link></div></main>;
}