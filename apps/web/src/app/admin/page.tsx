'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiRequest } from '@/lib/api';
import { formatMoney } from '@/lib/currency';

interface Admin { id: string; email: string; role: string }
interface DashboardData {
  metrics: {
    customers: { total: number; active: number };
    pendingIdentityReviews: number;
    loanProcessingFees: { pending: number; confirmed: number };
    paymentReconciliation: { pending: number; failed: number };
    loanApplications: { pending: number; approved: number; rejected: number };
    loans: { disbursed: number; overdue: number; repaid: number };
    withdrawals: { pending: number; completed: number };
    referrals: { registered: number; qualified: number };
    pendingReferralRewards: number;
    openSupportTickets: number;
    verifiedPaymentsKes: number;
    walletLiabilitiesKes: number;
  };
  recentActivity: Array<{ id: string; action: string; subjectType: string | null; outcome: string; createdAt: string }>;
}

export default function AdminPage() {
  const router = useRouter();
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);

  useEffect(() => {
    Promise.all([apiRequest<Admin>('/admin/auth/me'), apiRequest<DashboardData>('/admin/dashboard')])
      .then(([currentAdmin, data]) => { setAdmin(currentAdmin); setDashboard(data); })
      .catch(() => router.replace('/admin/login'));
  }, [router]);

  async function logout() {
    try { await apiRequest('/admin/auth/logout', { method: 'POST', body: '{}' }); } finally { router.replace('/admin/login'); }
  }

  if (!admin || !dashboard) return <main className="dashboard-loading">Loading administrator account…</main>;
  const metrics = dashboard.metrics;
  const metricItems = [
    ['Customers', metrics.customers.total, `${metrics.customers.active} active`],
    ['Verified receipts', formatMoney(metrics.verifiedPaymentsKes), 'Confirmed processing-fee, legacy activation and repayment payments'],
    ['Wallet liabilities', formatMoney(metrics.walletLiabilitiesKes), 'Posted wallet ledger balances'],
    ['Identity reviews', metrics.pendingIdentityReviews, 'Pending review'],
    ['Loan processing fees', metrics.loanProcessingFees.pending, `${metrics.loanProcessingFees.confirmed} confirmed`],
    ['Payment exceptions', metrics.paymentReconciliation.pending + metrics.paymentReconciliation.failed, `${metrics.paymentReconciliation.failed} failed`],
    ['Loan applications', metrics.loanApplications.pending, `${metrics.loanApplications.approved} approved · ${metrics.loanApplications.rejected} rejected`],
    ['Loans overdue', metrics.loans.overdue, `${metrics.loans.disbursed} disbursed · ${metrics.loans.repaid} repaid`],
    ['Withdrawal requests', metrics.withdrawals.pending, `${metrics.withdrawals.completed} completed`],
    ['Referral activity', metrics.referrals.registered + metrics.referrals.qualified, `${metrics.pendingReferralRewards} pending rewards`],
    ['Open support tickets', metrics.openSupportTickets, 'Awaiting response'],
  ];
  return <main className="dashboard-page admin-dashboard"><header className="dashboard-top"><Link className="wordmark" href="/"><span className="brand-mark">L+</span> loanplus <span className="admin-tag">ADMIN</span></Link><button className="quiet-button" onClick={logout}>Log out</button></header><section className="dashboard-welcome"><p className="eyebrow">SUPERADMIN PORTAL</p><h1>Administration.</h1><p>Signed in as {admin.email}. Every new sign-in requires a fresh email verification code.</p></section><section className="admin-metrics" aria-label="Current platform metrics">{metricItems.map(([label, value, detail]) => <article key={label}><span>{label}</span><b>{value}</b><small>{detail}</small></article>)}</section><section className="admin-shortcuts"><Link href="/admin/website"><span><b>Website &amp; Landing Page</b><small>Edit, preview and publish public website content</small></span><span aria-hidden="true">↗</span></Link><Link href="/admin/loans"><span><b>Loan products</b><small>Configure customer-facing terms</small></span><span aria-hidden="true">↗</span></Link><Link href="/admin/loans"><span><b>Application review</b><small>Approve, reject or request information</small></span><span aria-hidden="true">↗</span></Link><Link href="/admin/disbursements"><span><b>Manual disbursement</b><small>Confirm a verified transfer</small></span><span aria-hidden="true">↗</span></Link><Link href="/admin/settings"><span><b>Processing-fee and ledger settings</b><small>Configure accounting destination</small></span><span aria-hidden="true">↗</span></Link><Link href="/admin/support"><span><b>Support tickets</b><small>Respond to authenticated customers</small></span><span aria-hidden="true">↗</span></Link></section><section className="admin-activity"><div className="admin-workspace-heading"><div><p className="eyebrow">AUDIT LOG</p><h2>Recent administrative actions</h2></div><Link href="/admin/audit">View audit events ↗</Link></div>{dashboard.recentActivity.length === 0 ? <p className="empty-copy">No administrative actions recorded yet.</p> : dashboard.recentActivity.map((event) => <article key={event.id}><span>{event.action.replaceAll('_', ' ')}</span><small>{event.subjectType ?? 'SYSTEM'} · {event.outcome} · {new Date(event.createdAt).toLocaleString('en-KE')}</small></article>)}</section><p className="admin-data-note">Counts are read from the application database. Payment provider outcomes must still be reconciled before financial actions are considered complete.</p></main>;
}