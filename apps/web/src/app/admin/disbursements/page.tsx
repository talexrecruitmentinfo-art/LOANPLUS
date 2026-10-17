'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiRequest } from '@/lib/api';

interface PendingDisbursement {
  id: string;
  principalKes: number;
  chargesKes: number;
  totalRepayableKes: number;
  acceptedTermsVersion: string;
  createdAt: string;
  user: { id: string; fullName: string; email: string };
  application: { product: { name: string; durationDays: number } };
}

const formatKes = (amount: number) => `KSh ${new Intl.NumberFormat('en-KE').format(amount)}`;

export default function AdminDisbursementsPage() {
  const router = useRouter();
  const [loans, setLoans] = useState<PendingDisbursement[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function refresh() {
    setLoans(await apiRequest<PendingDisbursement[]>('/admin/loans/disbursements/pending'));
  }

  useEffect(() => { refresh().catch(() => router.replace('/admin/login')); }, [router]);

  async function confirmDisbursement(event: FormEvent<HTMLFormElement>, loan: PendingDisbursement) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    setError('');
    const values = Object.fromEntries(new FormData(form).entries());
    try {
      await apiRequest(`/admin/loans/${loan.id}/disbursement/confirm`, {
        method: 'POST',
        body: JSON.stringify(values),
      });
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Disbursement could not be confirmed.');
    } finally {
      setBusy(false);
    }
  }

  return <main className="dashboard-page"><header className="dashboard-top"><Link className="wordmark" href="/admin"><span className="brand-mark">L+</span> loanplus <span className="admin-tag">ADMIN</span></Link><Link className="quiet-button" href="/admin">Administration</Link></header><section className="dashboard-welcome"><p className="eyebrow">LENDING OPERATIONS</p><h1>Manual disbursement.</h1><p>Confirm only an externally verified transfer. Recording a reference asserts that funds were sent; it does not initiate a payout. Each confirmation posts a balanced ledger entry and creates the configured repayment schedule.</p></section>{error && <p className="admin-inline-error" role="alert">{error}</p>}<section className="admin-workspace"><div className="admin-workspace-heading"><div><p className="eyebrow">READY FOR OPERATOR CONFIRMATION</p><h2>Accepted loans</h2></div><span>{loans.length} awaiting confirmation</span></div>{loans.length === 0 ? <p className="empty-copy">No accepted loans are awaiting manual disbursement confirmation.</p> : <div className="admin-application-list">{loans.map((loan) => <article className="review-application" key={loan.id}><div className="review-summary"><div><h3>{loan.user.fullName}</h3><p>{loan.user.email} · {loan.application.product.name}</p></div><span className="status-label">Awaiting confirmation</span></div><dl><div><dt>Disburse</dt><dd>{formatKes(loan.principalKes)}</dd></div><div><dt>Total repayment</dt><dd>{formatKes(loan.totalRepayableKes)}</dd></div><div><dt>Duration</dt><dd>{loan.application.product.durationDays} days</dd></div><div><dt>Terms</dt><dd>{loan.acceptedTermsVersion}</dd></div></dl><form className="review-form" onSubmit={(event) => confirmDisbursement(event, loan)}><label>Verified transfer reference<input name="paymentReference" minLength={6} maxLength={100} pattern="[A-Za-z0-9._:-]+" required /></label><label>Confirmation reason<textarea name="reason" minLength={10} maxLength={500} rows={2} required /></label><button className="button" disabled={busy}>Confirm external transfer</button></form></article>)}</div>}</section></main>;
}