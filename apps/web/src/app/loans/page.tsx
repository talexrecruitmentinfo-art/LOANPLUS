'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
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
}

interface LoanApplication {
  id: string;
  requestedPrincipalKes: number;
  approvedPrincipalKes: number | null;
  approvedChargesKes: number | null;
  status: string;
  decisionReason: string | null;
  requestedInformation: string | null;
  submittedAt: string;
  reviewedAt: string | null;
  offerExpiresAt: string | null;
  product: { name: string; durationDays: number; termsVersion: string };
}

export default function LoanProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [customer, setCustomer] = useState<{ activationStatus: string } | null>(null);
  const [applications, setApplications] = useState<LoanApplication[]>([]);
  const [applicationAmounts, setApplicationAmounts] = useState<Record<string, string>>({});
  const [acceptedOffers, setAcceptedOffers] = useState<Record<string, boolean>>({});
  const [applyingProduct, setApplyingProduct] = useState<string | null>(null);
  const [applicationMessage, setApplicationMessage] = useState('');
  const [applicationError, setApplicationError] = useState('');
  const [applicationListError, setApplicationListError] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    apiRequest<Product[]>('/loans/products').then(setProducts).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'Products could not be loaded.');
    }).finally(() => setLoading(false));
    apiRequest<{ activationStatus: string }>('/auth/me', { cache: 'no-store' })
      .then(setCustomer)
      .catch(() => setCustomer(null));
    apiRequest<LoanApplication[]>('/loans/applications', { cache: 'no-store' })
      .then(setApplications)
      .catch((reason: unknown) => setApplicationListError(reason instanceof Error ? reason.message : 'Applications could not be loaded.'));
  }, []);

  async function submitApplication(event: FormEvent<HTMLFormElement>, product: Product) {
    event.preventDefault();
    setApplicationError('');
    setApplicationMessage('');
    setApplyingProduct(product.id);
    try {
      const result = await apiRequest<{ status: string; id: string }>('/loans/applications', {
        method: 'POST',
        body: JSON.stringify({
          productId: product.id,
          requestedPrincipalKes: Number(applicationAmounts[product.id]),
        }),
      });
      setApplicationMessage(`Application recorded with status ${result.status.replaceAll('_', ' ')}.`);
      setApplicationAmounts((current) => ({ ...current, [product.id]: '' }));
      setApplicationListError('');
      try {
        const latestApplications = await apiRequest<LoanApplication[]>('/loans/applications', { cache: 'no-store' });
        setApplications(latestApplications);
      } catch {
        setApplicationListError('Application was recorded, but its current status could not be refreshed.');
      }
    } catch (reason) {
      setApplicationError(reason instanceof Error ? reason.message : 'The application could not be submitted.');
    } finally {
      setApplyingProduct(null);
    }
  }

  async function acceptOffer(application: LoanApplication) {
    setApplicationError('');
    setApplicationMessage('');
    setApplyingProduct(application.id);
    try {
      await apiRequest(`/loans/applications/${application.id}/accept`, {
        method: 'POST',
        body: JSON.stringify({ termsAccepted: true }),
      });
      setApplicationMessage('Loan offer accepted. Disbursement status will update after authorized review.');
      setApplications(await apiRequest<LoanApplication[]>('/loans/applications', { cache: 'no-store' }));
      setApplicationListError('');
    } catch (reason) {
      setApplicationError(reason instanceof Error ? reason.message : 'This offer could not be accepted.');
    } finally {
      setApplyingProduct(null);
    }
  }

  return (
    <main className="dashboard-page">
      <header className="dashboard-top">
        <Link className="wordmark" href="/"><span className="brand-mark">L+</span> loanplus</Link>
        <Link className="quiet-button" href="/dashboard">My account</Link>
      </header>
      <section className="dashboard-welcome">
        <p className="eyebrow">LOAN PRODUCTS</p>
        <h1>Clear terms first.</h1>
        <p>Products are shown only when configured by LoanPlus. Review charges and repayment dates before accepting any offer. Approval is not guaranteed.</p>
      </section>
      {applicationMessage && <p className="admin-inline-notice" role="status">{applicationMessage}</p>}
      {applicationError && <p className="form-error" role="alert">{applicationError}</p>}
      {customer && <section className="customer-ledger-list"><div className="customer-ledger-heading"><h2>Your loan applications</h2><span>{applications.length}</span></div>{applicationListError ? <p className="form-error" role="alert">{applicationListError}</p> : applications.length === 0 ? <p>No loan applications recorded.</p> : applications.map((application) => <article className="customer-loan-application" key={application.id}><div><b>{application.product.name}</b><small>Requested {formatKes(application.requestedPrincipalKes)} · {new Date(application.submittedAt).toLocaleDateString('en-KE')}</small></div><span className="status-label">{application.status.replaceAll('_', ' ')}</span>{application.decisionReason && <p>{application.decisionReason}</p>}{application.requestedInformation && <p>Information requested: {application.requestedInformation}</p>}{application.approvedPrincipalKes !== null && application.approvedChargesKes !== null && <dl><div><dt>Approved principal</dt><dd>{formatKes(application.approvedPrincipalKes)}</dd></div><div><dt>Charges</dt><dd>{formatKes(application.approvedChargesKes)}</dd></div><div><dt>Total repayable</dt><dd>{formatKes(application.approvedPrincipalKes + application.approvedChargesKes)}</dd></div><div><dt>Terms version</dt><dd>{application.product.termsVersion} · {application.product.durationDays} days</dd></div></dl>}{application.offerExpiresAt && <small>Offer expires {new Date(application.offerExpiresAt).toLocaleString('en-KE')}</small>}{application.status === 'APPROVED' && <><label className="check-row"><input type="checkbox" checked={acceptedOffers[application.id] === true} onChange={(event) => setAcceptedOffers((current) => ({ ...current, [application.id]: event.target.checked }))} /><span>I accept the approved offer and displayed terms version {application.product.termsVersion}.</span></label><button className="button" type="button" disabled={applyingProduct !== null || acceptedOffers[application.id] !== true} onClick={() => void acceptOffer(application)}>{applyingProduct === application.id ? 'Accepting…' : 'Accept approved offer'}</button></>}</article>)}</section>}
      <section className="product-list">
        {loading ? <p>Loading configured products…</p> : error ? <p className="form-error" role="alert">{error}</p> : products.length === 0 ? (
          <div className="dashboard-empty"><p className="eyebrow">NO PRODUCTS AVAILABLE</p><h2>There are no active loan products.</h2><p>Loan terms will appear here when they have been configured and approved.</p></div>
        ) : products.map((product) => (
          <article className="product-row" key={product.id}>
            <div><p className="eyebrow">{product.durationDays} DAY TERM</p><h2>{product.name}</h2><p>{product.description}</p></div>
            <dl>
              <div><dt>Principal range</dt><dd>{formatKes(product.minimumPrincipalKes)} – {formatKes(product.maximumPrincipalKes)}</dd></div>
              <div><dt>Interest</dt><dd>{(product.interestRateBps / 100).toFixed(2)}%</dd></div>
              <div><dt>Fixed charge</dt><dd>{formatKes(product.flatFeeKes)}</dd></div>
              <div><dt>Terms version</dt><dd>{product.termsVersion}</dd></div>
            </dl>
            <p className="product-disclosure">Final total repayment and dates depend on the approved offer. You must review the full terms before accepting.</p>
            {!customer ? (
              <Link className="button" href="/login">Sign in to apply <span aria-hidden="true">↗</span></Link>
            ) : customer.activationStatus !== 'ACTIVE' ? (
              <Link className="button" href="/activation">Complete account activation <span aria-hidden="true">↗</span></Link>
            ) : (
              <form className="loan-application-form" onSubmit={(event) => void submitApplication(event, product)}>
                <label>Requested principal ({formatKes(product.minimumPrincipalKes)} to {formatKes(product.maximumPrincipalKes)})
                  <input
                    type="number"
                    min={product.minimumPrincipalKes}
                    max={product.maximumPrincipalKes}
                    step="1"
                    value={applicationAmounts[product.id] ?? ''}
                    onChange={(event) => setApplicationAmounts((current) => ({ ...current, [product.id]: event.target.value }))}
                    required
                  />
                </label>
                <button className="button" disabled={applyingProduct !== null}>
                  {applyingProduct === product.id ? 'Submitting…' : 'Submit application'}
                </button>
              </form>
            )}
          </article>
        ))}
      </section>
    </main>
  );
}