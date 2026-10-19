'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiRequest } from '@/lib/api';
import { formatMoney as formatKes } from '@/lib/currency';

interface Product {
  id: string;
  name: string;
  description: string;
  minimumPrincipalKes: number;
  maximumPrincipalKes: number;
  durationDays: number;
  interestRateBps: number;
  flatFeeKes: number;
  termsVersion: string;
  isAvailable: boolean;
}

interface Application {
  id: string;
  status: string;
  requestedPrincipalKes: number;
  submittedAt: string | null;
  applicationData: Record<string, unknown>;
  product: { name: string };
  processingFeePayments: Array<{
    internalReference: string;
    status: string;
    amountKes: number;
    receiptReference: string | null;
    confirmedAt: string | null;
  }>;
  user: { fullName: string; email: string; identityStatus: string };
}

export default function AdminLoansPage() {
  const router = useRouter();
  const [products, setProducts] = useState<Product[]>([]);
  const [applications, setApplications] = useState<Application[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function refresh() {
    const [nextProducts, nextApplications] = await Promise.all([
      apiRequest<Product[]>('/admin/loans/products'),
      apiRequest<Application[]>('/admin/loans/applications'),
    ]);
    setProducts(nextProducts);
    setApplications(nextApplications);
  }

  useEffect(() => {
    refresh().catch(() => router.replace('/admin/login'));
  }, [router]);

  async function createProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      await apiRequest<Product>('/admin/loans/products', {
        method: 'POST',
        body: JSON.stringify({
          ...values,
          minimumPrincipalKes: Number(values.minimumPrincipalKes),
          maximumPrincipalKes: Number(values.maximumPrincipalKes),
          durationDays: Number(values.durationDays),
          interestRateBps: Number(values.interestRateBps),
          flatFeeKes: Number(values.flatFeeKes),
          isAvailable: values.isAvailable === 'on',
        }),
      });
      event.currentTarget.reset();
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Product could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleProduct(product: Product) {
    setBusy(true);
    setError('');
    try {
      await apiRequest(`/admin/loans/products/${product.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isAvailable: !product.isAvailable }),
      });
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Product could not be updated.');
    } finally {
      setBusy(false);
    }
  }

  async function saveDecision(form: HTMLFormElement, application: Application, decision: 'APPROVE' | 'REJECT') {
    setBusy(true);
    setError('');
    const values = Object.fromEntries(new FormData(form).entries());
    try {
      await apiRequest(`/admin/loans/applications/${application.id}/decision`, {
        method: 'PATCH',
        body: JSON.stringify({
          decision,
          reason: values.reason,
          approvedPrincipalKes: decision === 'APPROVE' ? Number(values.approvedPrincipalKes) : undefined,
        }),
      });
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The application decision could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  async function reviewApplication(event: FormEvent<HTMLFormElement>, application: Application) {
    event.preventDefault();
    await saveDecision(event.currentTarget, application, 'APPROVE');
  }

  return (
    <main className="dashboard-page">
      <header className="dashboard-top"><Link className="wordmark" href="/admin"><span className="brand-mark">L+</span> loanplus <span className="admin-tag">ADMIN</span></Link><Link className="quiet-button" href="/admin">Administration</Link></header>
      <section className="dashboard-welcome"><p className="eyebrow">LENDING OPERATIONS</p><h1>Products &amp; review.</h1><p>Only configured products are available. Application payment, review, approval, and disbursement remain distinct and audited.</p></section>
      {error && <p className="admin-inline-error" role="alert">{error}</p>}
      <section className="admin-workspace">
        <div className="admin-workspace-heading"><div><p className="eyebrow">CONFIGURATION</p><h2>Loan products</h2></div><span>{products.length} configured</span></div>
        <form className="product-config-form" onSubmit={createProduct}>
          <label>Product name<input name="name" minLength={2} maxLength={100} required /></label>
          <label>Description<textarea name="description" minLength={10} maxLength={1000} rows={2} required /></label>
          <div className="form-row"><label>Minimum principal (KSh)<input name="minimumPrincipalKes" type="number" min="1" step="1" required /></label><label>Maximum principal (KSh)<input name="maximumPrincipalKes" type="number" min="1" step="1" required /></label></div>
          <div className="form-row"><label>Duration (days)<input name="durationDays" type="number" min="1" max="3650" required /></label><label>Interest rate (basis points)<input name="interestRateBps" type="number" min="0" max="1000000" required /></label></div>
          <div className="form-row"><label>Fixed fee (KSh)<input name="flatFeeKes" type="number" min="0" step="1" required /></label><label>Terms version<input name="termsVersion" minLength={1} maxLength={40} required /></label></div>
          <label className="check-row"><input name="isAvailable" type="checkbox" /><span>Make product available to customers</span></label>
          <button className="button" disabled={busy}>Save product <span aria-hidden="true">↗</span></button>
        </form>
        <div className="admin-product-list">{products.map((item) => <article key={item.id}><div><b>{item.name}</b><small>{formatKes(item.minimumPrincipalKes)}–{formatKes(item.maximumPrincipalKes)} · {item.durationDays} days · {(item.interestRateBps / 100).toFixed(2)}% · fee {formatKes(item.flatFeeKes)}</small></div><button className="quiet-button" disabled={busy} onClick={() => toggleProduct(item)}>{item.isAvailable ? 'Pause product' : 'Enable product'}</button></article>)}{products.length === 0 && <p className="empty-copy">No loan products are configured.</p>}</div>
      </section>
      <section className="admin-workspace">
        <div className="admin-workspace-heading"><div><p className="eyebrow">MANUAL REVIEW</p><h2>Loan applications</h2></div><span>{applications.filter((item) => ['SUBMITTED', 'UNDER_REVIEW'].includes(item.status)).length} awaiting review</span></div>
        <div className="admin-application-list">{applications.map((application) => {
          const detail = (key: string) => typeof application.applicationData[key] === 'string' ? application.applicationData[key] as string : 'Not provided';
          return <article className="review-application" key={application.id}>
            <div className="review-summary"><div><h3>{application.user.fullName}</h3><p>{application.user.email} · {application.product.name} · Ref {application.id}</p></div><span className="status-label">{application.status.replaceAll('_', ' ')}</span></div>
            <dl>
              <div><dt>Requested amount</dt><dd>{formatKes(application.requestedPrincipalKes)}</dd></div>
              <div><dt>Processing fees</dt><dd>{application.processingFeePayments.length
                ? application.processingFeePayments.map((payment) => `${payment.status} · ${payment.internalReference}${payment.receiptReference ? ` · receipt ${payment.receiptReference}` : ''}`).join(' | ')
                : 'Not paid'}</dd></div>
              <div><dt>Identity status</dt><dd>{application.user.identityStatus.replaceAll('_', ' ')}</dd></div>
              <div><dt>Submitted</dt><dd>{application.submittedAt ? new Date(application.submittedAt).toLocaleString('en-KE') : 'Not recorded'}</dd></div>
            </dl>
            <div className="review-guarantors"><b>Guarantors</b><p>1. {detail('guarantorOneName')} · {detail('guarantorOnePhone')}</p><p>2. {detail('guarantorTwoName')} · {detail('guarantorTwoPhone')}</p></div>
            {['SUBMITTED', 'UNDER_REVIEW'].includes(application.status) && <form className="review-form" onSubmit={(event) => reviewApplication(event, application)}>
              <label>Decision reason or material amount change note<textarea name="reason" minLength={10} maxLength={1000} rows={2} required /></label>
              <label>Approved principal (KSh)<input name="approvedPrincipalKes" type="number" min="1" max={application.requestedPrincipalKes} defaultValue={application.requestedPrincipalKes} required /></label>
              <div><button className="button" disabled={busy}>Approve Loan</button><button className="quiet-button" type="button" disabled={busy} onClick={(event) => { const form = event.currentTarget.form; if (form?.reportValidity()) void saveDecision(form, application, 'REJECT'); }}>Reject</button></div>
            </form>}
          </article>;
        })}{applications.length === 0 && <p className="empty-copy">No paid applications have been submitted for review.</p>}</div>
      </section>
    </main>
  );
}