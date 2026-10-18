'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { apiRequest } from '@/lib/api';
import { formatMoney } from '@/lib/currency';

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

interface ProcessingFeeQuote {
  amountKes: number;
  currency: string;
  refundPolicyStatus: string;
  refundPolicyVersion: string | null;
  refundPolicyDisclosure: string | null;
}

interface LoanApplication {
  id: string;
  requestedPrincipalKes: number;
  approvedPrincipalKes: number | null;
  approvedChargesKes: number | null;
  approvedTermsSnapshot: null | {
    productName: string;
    termsVersion: string;
    durationDays: number;
    interestRateBps: number;
    flatFeeKes: number;
    approvedPrincipalKes: number;
    approvedChargesKes: number;
    totalRepayableKes: number;
  };
  status: string;
  decisionReason: string | null;
  requestedInformation: string | null;
  submittedAt: string | null;
  createdAt: string;
  reviewedAt: string | null;
  offerExpiresAt: string | null;
  applicationData: Record<string, unknown>;
  processingFeePayment: null | {
    id: string;
    internalReference: string;
    status: string;
    amountKes: number;
    currency: string;
    failureCode: string | null;
    createdAt: string;
    confirmedAt: string | null;
    receiptReference: string | null;
  };
  loan: null | {
    status: string;
    disbursedAt: string | null;
    disbursement: null | { amountKes: number; status: string; paymentReference: string; confirmedAt: string | null };
  };
  product: { name: string };
}

interface ApplicationForm {
  productId: string;
  requestedPrincipalKes: string;
  guarantorOneName: string;
  guarantorOnePhone: string;
  guarantorTwoName: string;
  guarantorTwoPhone: string;
}

const emptyForm: ApplicationForm = {
  productId: '',
  requestedPrincipalKes: '',
  guarantorOneName: '',
  guarantorOnePhone: '',
  guarantorTwoName: '',
  guarantorTwoPhone: '',
};

function estimateTotalRepayment(product: Product, principalKes: number): number | null {
  if (!Number.isSafeInteger(principalKes) || principalKes < 1 ||
    !Number.isSafeInteger(product.interestRateBps) || product.interestRateBps < 0 ||
    !Number.isSafeInteger(product.flatFeeKes) || product.flatFeeKes < 0) return null;
  const weightedPrincipal = principalKes * product.interestRateBps;
  if (!Number.isSafeInteger(weightedPrincipal)) return null;
  const interest = Math.floor(weightedPrincipal / 10_000) + (weightedPrincipal % 10_000 === 0 ? 0 : 1);
  const total = principalKes + interest + product.flatFeeKes;
  return Number.isSafeInteger(total) ? total : null;
}

function statusLabel(application: LoanApplication): string {
  if (application.status === 'DRAFT' || application.status === 'PROCESSING_PAYMENT_PENDING') {
    if (application.processingFeePayment?.failureCode) return 'Processing Payment Unresolved';
    if (application.processingFeePayment?.status === 'FAILED') return 'Processing Payment Failed';
    if (application.processingFeePayment?.status === 'PENDING') return 'Processing Payment Pending';
    return application.status === 'DRAFT' ? 'Draft' : 'Processing Payment Unresolved';
  }
  if (application.status === 'SUBMITTED') return 'Submitted — Awaiting Admin Review';
  if (application.status === 'UNDER_REVIEW') return 'Under Review';
  if (application.status === 'APPROVED') return 'Approved — Awaiting Offer Acceptance';
  if (application.status === 'ACCEPTED') {
    if (application.loan?.status === 'DISBURSED' || application.loan?.disbursement?.status === 'CONFIRMED') return 'Disbursed';
    return 'Approved — Awaiting Disbursement';
  }
  if (application.status === 'REJECTED') return 'Rejected';
  return application.status.replaceAll('_', ' ');
}

function fieldError(name: string, value: string, product?: Product): string {
  if (!value.trim()) return 'This field is required.';
  if (name.endsWith('Name') && value.trim().replace(/\s+/g, ' ').length < 2) return 'Enter the full name.';
  if (name.endsWith('Phone') && !/^(?:\+?254|0)?[17]\d{8}$/.test(value.replace(/[\s()-]/g, ''))) {
    return 'Enter a valid Kenyan mobile number.';
  }
  if (name === 'requestedPrincipalKes') {
    const amount = Number(value);
    if (!Number.isSafeInteger(amount) || amount < 1) return 'Enter a valid positive amount in whole KSh.';
    if (product && (amount < product.minimumPrincipalKes || amount > product.maximumPrincipalKes)) {
      return `Choose an amount from ${formatMoney(product.minimumPrincipalKes)} to ${formatMoney(product.maximumPrincipalKes)}.`;
    }
  }
  return '';
}

export default function LoanProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [processingFeeQuote, setProcessingFeeQuote] = useState<ProcessingFeeQuote | null>(null);
  const [applications, setApplications] = useState<LoanApplication[]>([]);
  const [form, setForm] = useState<ApplicationForm>(emptyForm);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [reviewing, setReviewing] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [acceptedOffers, setAcceptedOffers] = useState<Record<string, boolean>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const creationKey = useRef<string | null>(null);
  const feeKey = useRef<string | null>(null);

  const product = products.find((item) => item.id === form.productId);

  async function refreshApplications() {
    setApplications(await apiRequest<LoanApplication[]>('/loans/applications', { cache: 'no-store' }));
  }

  useEffect(() => {
    apiRequest<ProcessingFeeQuote>('/payments/loan-processing-fee-quote', { cache: 'no-store' })
      .then(setProcessingFeeQuote)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Processing-fee details could not be loaded.'));
    Promise.all([
      apiRequest<Product[]>('/loans/products').then(setProducts),
      apiRequest('/auth/me', { cache: 'no-store' }).then(() => setSignedIn(true)).catch(() => setSignedIn(false)),
      apiRequest<LoanApplication[]>('/loans/applications', { cache: 'no-store' }).then(setApplications)
        .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Applications could not be loaded.')),
    ]).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Loan products could not be loaded.'))
      .finally(() => setLoading(false));
  }, []);

  function updateField(field: keyof ApplicationForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: '' }));
  }

  function reviewApplication(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields: Array<keyof ApplicationForm> = [
      'productId', 'requestedPrincipalKes', 'guarantorOneName', 'guarantorOnePhone',
      'guarantorTwoName', 'guarantorTwoPhone',
    ];
    const errors = Object.fromEntries(fields.map((name) => [name, fieldError(name, form[name], product)]));
    if (form.guarantorOnePhone.replace(/\D/g, '').slice(-9) === form.guarantorTwoPhone.replace(/\D/g, '').slice(-9)) {
      errors.guarantorTwoPhone = 'Guarantors must have different phone numbers.';
    }
    setFieldErrors(errors);
    if (Object.values(errors).some(Boolean)) return;
    setError('');
    setReviewing(true);
  }

  async function payProcessingFee() {
    if (!product || !signedIn || !processingFeeQuote || processingFeeQuote.currency !== 'KES' || !Number.isSafeInteger(processingFeeQuote.amountKes) || processingFeeQuote.refundPolicyStatus !== 'CONFIGURED' || !processingFeeQuote.refundPolicyDisclosure) return;
    setBusyId('new-application');
    setError('');
    setNotice('');
    try {
      if (!creationKey.current) creationKey.current = crypto.randomUUID();
      const application = await apiRequest<{ id: string }>('/loans/applications', {
        method: 'POST',
        headers: { 'Idempotency-Key': creationKey.current },
        body: JSON.stringify({
          ...form,
          requestedPrincipalKes: Number(form.requestedPrincipalKes),
        }),
      });
      if (!feeKey.current) feeKey.current = crypto.randomUUID();
      const payment = await apiRequest<{ reference: string; status: string; message: string }>('/payments/loan-processing-fee', {
        method: 'POST',
        headers: { 'Idempotency-Key': feeKey.current },
        body: JSON.stringify({ applicationId: application.id, reviewConfirmed: true }),
      });
      setNotice(payment.message);
      creationKey.current = null;
      feeKey.current = null;
      setReviewing(false);
      setForm(emptyForm);
      await refreshApplications();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The processing-fee request could not be completed.');
      await refreshApplications().catch(() => undefined);
    } finally {
      setBusyId(null);
    }
  }

  async function resumeProcessingFee(applicationId: string) {
    setBusyId(applicationId);
    setError('');
    setNotice('');
    try {
      const payment = await apiRequest<{ status: string; message: string }>('/payments/loan-processing-fee', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ applicationId, reviewConfirmed: true }),
      });
      setNotice(payment.message);
      await refreshApplications();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The payment status could not be refreshed.');
    } finally {
      setBusyId(null);
    }
  }

  async function acceptOffer(application: LoanApplication) {
    setBusyId(application.id);
    setError('');
    setNotice('');
    try {
      await apiRequest(`/loans/applications/${application.id}/accept`, {
        method: 'POST',
        body: JSON.stringify({ termsAccepted: true }),
      });
      setNotice('Loan offer accepted. Disbursement remains a separate authorized step.');
      await refreshApplications();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'This offer could not be accepted.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <main className="dashboard-page">
      <header className="dashboard-top">
        <Link className="wordmark" href="/"><span className="brand-mark">L+</span> loanplus</Link>
        <Link className="quiet-button" href="/dashboard">My account</Link>
      </header>
      <section className="dashboard-welcome">
        <p className="eyebrow">LOAN APPLICATION</p>
        <h1>Apply with clear terms.</h1>
        <p>Complete your application, review the details, then pay the configured loan processing fee. Payment does not guarantee approval or disbursement.</p>
      </section>
      {notice && <p className="admin-inline-notice" role="status">Payment request status: pending verification. {notice}</p>}
      {error && <p className="admin-inline-error" role="alert">{error}</p>}
      {!signedIn && !loading && <p className="product-list"><Link className="button" href="/login">Sign in to apply</Link></p>}
      {signedIn && products.length > 0 && (
        <section className="loan-application-panel" aria-labelledby="apply-heading">
          <h2 id="apply-heading">{reviewing ? 'Review your application' : 'Your application'}</h2>
          <ol className="loan-step-indicator" aria-label={`Application step ${reviewing ? 2 : 1} of 4`}>
            <li aria-current={!reviewing ? 'step' : undefined}><span>1</span><b>Details</b></li>
            <li aria-current={reviewing ? 'step' : undefined}><span>2</span><b>Review</b></li>
            <li><span>3</span><b>Payment</b></li>
            <li><span>4</span><b>Decision</b></li>
          </ol>
          {!reviewing ? (
            <form className="loan-application-form loan-application-guided" onSubmit={reviewApplication} noValidate>
              <label>Loan product
                <select value={form.productId} onChange={(event) => updateField('productId', event.target.value)} aria-invalid={Boolean(fieldErrors.productId)} aria-describedby={fieldErrors.productId ? 'product-error' : undefined} required>
                  <option value="">Choose an available product</option>
                  {products.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.durationDays} days</option>)}
                </select>
                {fieldErrors.productId && <small id="product-error" role="alert">{fieldErrors.productId}</small>}
              </label>
              <label>Requested loan amount (KSh){product && <span className="loan-field-hint">{formatMoney(product.minimumPrincipalKes)} – {formatMoney(product.maximumPrincipalKes)}</span>}
                <input type="number" inputMode="numeric" min={product?.minimumPrincipalKes ?? 1} max={product?.maximumPrincipalKes ?? 1_000_000_000} step="1" value={form.requestedPrincipalKes} onChange={(event) => updateField('requestedPrincipalKes', event.target.value)} aria-invalid={Boolean(fieldErrors.requestedPrincipalKes)} aria-describedby={fieldErrors.requestedPrincipalKes ? 'amount-error' : undefined} required />
                {fieldErrors.requestedPrincipalKes && <small id="amount-error" role="alert">{fieldErrors.requestedPrincipalKes}</small>}
              </label>
              <fieldset>
                <legend>Guarantor 1</legend>
                <label>Full name<input autoComplete="name" value={form.guarantorOneName} onChange={(event) => updateField('guarantorOneName', event.target.value)} aria-invalid={Boolean(fieldErrors.guarantorOneName)} required />{fieldErrors.guarantorOneName && <small role="alert">{fieldErrors.guarantorOneName}</small>}</label>
                <label>Phone number<input type="tel" inputMode="tel" autoComplete="tel" placeholder="07XX XXX XXX" value={form.guarantorOnePhone} onChange={(event) => updateField('guarantorOnePhone', event.target.value)} aria-invalid={Boolean(fieldErrors.guarantorOnePhone)} required />{fieldErrors.guarantorOnePhone && <small role="alert">{fieldErrors.guarantorOnePhone}</small>}</label>
              </fieldset>
              <fieldset>
                <legend>Guarantor 2</legend>
                <label>Full name<input autoComplete="name" value={form.guarantorTwoName} onChange={(event) => updateField('guarantorTwoName', event.target.value)} aria-invalid={Boolean(fieldErrors.guarantorTwoName)} required />{fieldErrors.guarantorTwoName && <small role="alert">{fieldErrors.guarantorTwoName}</small>}</label>
                <label>Phone number<input type="tel" inputMode="tel" autoComplete="tel" placeholder="07XX XXX XXX" value={form.guarantorTwoPhone} onChange={(event) => updateField('guarantorTwoPhone', event.target.value)} aria-invalid={Boolean(fieldErrors.guarantorTwoPhone)} required />{fieldErrors.guarantorTwoPhone && <small role="alert">{fieldErrors.guarantorTwoPhone}</small>}</label>
              </fieldset>
              <button className="button" type="submit">Review details <span aria-hidden="true">→</span></button>
            </form>
          ) : (
            <div className="loan-application-review">
              <dl>
                <div><dt>Product</dt><dd>{product?.name}</dd></div>
                <div><dt>Requested amount</dt><dd>{formatMoney(Number(form.requestedPrincipalKes))}</dd></div>
                <div><dt>Guarantor 1</dt><dd>{form.guarantorOneName} · {form.guarantorOnePhone}</dd></div>
                <div><dt>Guarantor 2</dt><dd>{form.guarantorTwoName} · {form.guarantorTwoPhone}</dd></div>
                {product && Number.isSafeInteger(Number(form.requestedPrincipalKes)) && <>
                  <div><dt>Configured interest rate</dt><dd>{(product.interestRateBps / 100).toFixed(2)}%</dd></div>
                  <div><dt>Repayment term</dt><dd>{product.durationDays} days</dd></div>
                  <div><dt>Configured product fee</dt><dd>{formatMoney(product.flatFeeKes)}</dd></div>
                  <div><dt>Estimated total repayment</dt><dd>{(() => {
                    const estimate = estimateTotalRepayment(product, Number(form.requestedPrincipalKes));
                    return estimate === null ? 'Unavailable' : formatMoney(estimate);
                  })()}</dd></div>
                </>}
                <div><dt>Loan Processing Fee</dt><dd>{processingFeeQuote ? formatMoney(processingFeeQuote.amountKes) : 'Unavailable'}</dd></div>
              </dl>
              <p>The processing fee is paid separately and is not included in the estimated repayment. Estimates use the current configured product terms; an authorized approved offer may differ and must be reviewed before acceptance. The fee is not wallet funding, loan approval, or a promise of disbursement. Your M-Pesa PIN is entered only in Safaricom’s prompt.</p>
              {processingFeeQuote?.refundPolicyStatus === 'CONFIGURED' && processingFeeQuote.refundPolicyDisclosure && <p>{processingFeeQuote.refundPolicyDisclosure} <small>Policy version {processingFeeQuote.refundPolicyVersion}.</small></p>}
              {processingFeeQuote?.refundPolicyStatus !== 'CONFIGURED' && <p role="status">Approved refund conditions are not configured, so processing-fee payment is unavailable. Review the published terms or contact support.</p>}
              {(!processingFeeQuote || processingFeeQuote.currency !== 'KES' || !Number.isSafeInteger(processingFeeQuote.amountKes)) && <p role="alert">Processing-fee details are unavailable, so payment cannot be started. Refresh the page to try again.</p>}
              <div className="loan-review-actions">
                <button className="quiet-button" type="button" disabled={busyId !== null} onClick={() => setReviewing(false)}>Edit details</button>
                <button className="button" type="button" disabled={busyId !== null || !processingFeeQuote || processingFeeQuote.currency !== 'KES' || !Number.isSafeInteger(processingFeeQuote.amountKes) || processingFeeQuote.refundPolicyStatus !== 'CONFIGURED' || !processingFeeQuote.refundPolicyDisclosure} onClick={() => void payProcessingFee()}>{busyId === 'new-application' ? 'Requesting payment…' : `Pay Loan Processing Fee — ${processingFeeQuote ? formatMoney(processingFeeQuote.amountKes) : 'unavailable'}`}</button>
              </div>
            </div>
          )}
        </section>
      )}
      <section className="product-list">
        {loading ? <p>Loading configured loan products…</p> : products.length === 0 ? <div className="dashboard-empty"><p className="eyebrow">NO PRODUCTS AVAILABLE</p><h2>There are no active loan products.</h2><p>Configured borrowing options will appear here when available.</p></div> : products.map((item) => (
          <article className="product-row" key={item.id}>
            <div><p className="eyebrow">{item.durationDays} DAY TERM</p><h2>{item.name}</h2><p>{item.description}</p></div>
            <dl>
              <div><dt>Principal range</dt><dd>{formatMoney(item.minimumPrincipalKes)} – {formatMoney(item.maximumPrincipalKes)}</dd></div>
              <div><dt>Interest</dt><dd>{(item.interestRateBps / 100).toFixed(2)}%</dd></div>
              <div><dt>Fixed charge</dt><dd>{formatMoney(item.flatFeeKes)}</dd></div>
              <div><dt>Terms version</dt><dd>{item.termsVersion}</dd></div>
            </dl>
          </article>
        ))}
      </section>
      {signedIn && <section className="customer-ledger-list">
        <div className="customer-ledger-heading"><h2>My loan applications</h2><div><span>{applications.length}</span><button className="quiet-button" type="button" disabled={busyId !== null} onClick={() => void refreshApplications().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Application status could not be refreshed.'))}>Refresh status</button></div></div>
        {applications.length === 0 ? <p>No applications yet. Select a loan product and complete the application above.</p> : applications.map((application) => {
          const terms = application.approvedTermsSnapshot;
          const guarantor = (key: string) => typeof application.applicationData[key] === 'string' ? application.applicationData[key] as string : '—';
          const fee = application.processingFeePayment;
          return (
            <article className="customer-loan-application" key={application.id}>
              <div><b>{terms?.productName ?? application.product.name}</b><small>Reference {application.id} · Requested {formatMoney(application.requestedPrincipalKes)}</small></div>
              <span className="status-label">{statusLabel(application)}</span>
              {application.status === 'DRAFT' && !fee && <div className="draft-application-details">
                <p>Draft saved. Review the application details and continue to the processing-fee payment step.</p>
                <small>Guarantor 1: {guarantor('guarantorOneName')} · {guarantor('guarantorOnePhone')}</small>
                <small>Guarantor 2: {guarantor('guarantorTwoName')} · {guarantor('guarantorTwoPhone')}</small>
                <p>Loan Processing Fee — {processingFeeQuote ? formatMoney(processingFeeQuote.amountKes) : 'details unavailable'}. Paying it does not guarantee approval or disbursement and does not add funds to your wallet.</p>
                <button className="quiet-button" type="button" disabled={busyId !== null || !processingFeeQuote || processingFeeQuote.currency !== 'KES' || !Number.isSafeInteger(processingFeeQuote.amountKes) || processingFeeQuote.refundPolicyStatus !== 'CONFIGURED' || !processingFeeQuote.refundPolicyDisclosure} onClick={() => void resumeProcessingFee(application.id)}>Review details and request fee payment</button>
              </div>}
              {fee && <dl>
                <div><dt>Loan Processing Fee — {formatMoney(fee.amountKes)}</dt><dd>{fee.status === 'CONFIRMED' ? 'Paid and verified' : fee.status === 'FAILED' ? 'Failed' : fee.failureCode ? 'Unresolved — do not pay again' : fee.status.replaceAll('_', ' ')}</dd></div>
                <div><dt>Payment reference</dt><dd>{fee.internalReference}</dd></div>
                {fee.confirmedAt && <div><dt>Confirmed</dt><dd>{new Date(fee.confirmedAt).toLocaleString('en-KE')}</dd></div>}
                {fee.status === 'PENDING' && <div><dt>Payment outcome</dt><dd>Refresh this page to see the latest verified status. Do not make another payment while this request is pending or unresolved.</dd></div>}
              </dl>}
              {application.submittedAt && <small>Submitted {new Date(application.submittedAt).toLocaleString('en-KE')}</small>}
              {application.reviewedAt && <small>Decision recorded {new Date(application.reviewedAt).toLocaleString('en-KE')}</small>}
              {application.decisionReason && <p>{application.decisionReason}</p>}
              {application.requestedInformation && <p>Information requested: {application.requestedInformation}</p>}
              {application.approvedPrincipalKes !== null && application.approvedChargesKes !== null && <dl>
                <div><dt>Approved principal</dt><dd>{formatMoney(application.approvedPrincipalKes)}</dd></div>
                <div><dt>Charges</dt><dd>{formatMoney(application.approvedChargesKes)}</dd></div>
                <div><dt>Total repayable</dt><dd>{formatMoney(application.approvedPrincipalKes + application.approvedChargesKes)}</dd></div>
                <div><dt>Approved terms</dt><dd>{terms ? `${terms.termsVersion} · ${terms.durationDays} days` : 'Needs staff review'}</dd></div>
              </dl>}
              {application.loan?.disbursement?.status === 'CONFIRMED' && <p>Disbursed amount: {formatMoney(application.loan.disbursement.amountKes)} · {application.loan.disbursement.paymentReference}</p>}
              {application.offerExpiresAt && <small>Offer expires {new Date(application.offerExpiresAt).toLocaleString('en-KE')}</small>}
              {application.status === 'APPROVED' && terms && <>
                <label className="check-row"><input type="checkbox" checked={acceptedOffers[application.id] === true} onChange={(event) => setAcceptedOffers((current) => ({ ...current, [application.id]: event.target.checked }))} /><span>I accept the approved offer and displayed terms version {terms.termsVersion}.</span></label>
                <button className="button" type="button" disabled={busyId !== null || acceptedOffers[application.id] !== true} onClick={() => void acceptOffer(application)}>{busyId === application.id ? 'Accepting…' : 'Accept approved offer'}</button>
              </>}
              {application.status === 'APPROVED' && !terms && <p role="status">This offer needs staff review before it can be accepted safely. Contact support for assistance.</p>}
            </article>
          );
        })}
      </section>}
    </main>
  );
}
