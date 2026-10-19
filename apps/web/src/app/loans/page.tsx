'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { apiRequest } from '@/lib/api';
import { formatMoney } from '@/lib/currency';
import { loadLoanApplicationStatus } from '@/lib/payment-status.mjs';

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
  paymentAvailable: boolean;
  unavailableReasons: string[];
}

interface LoanApplication {
  id: string;
  productId: string;
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
  processingFeePayments: Array<{
    id: string;
    internalReference: string;
    status: string;
    amountKes: number;
    currency: string;
    failureCode: string | null;
    createdAt: string;
    confirmedAt: string | null;
    receiptReference: string | null;
    initiationPhase: string | null;
  }>;
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
    const latest = application.processingFeePayments[0];
    if (application.processingFeePayments.some((attempt) =>
      attempt.status === 'PENDING' || (attempt.status === 'FAILED' && attempt.failureCode === 'MPESA_RESULT_4999'),
    )) return 'Processing Payment Unresolved';
    if (latest?.status === 'CONFIRMED') return 'Payment Confirmed — Awaiting Review';
    if (latest?.status === 'FAILED') return 'Processing Payment Failed';
    if (latest?.status === 'PENDING') return 'Processing Payment Pending';
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

function isRetryableFeeFailure(attempt: LoanApplication['processingFeePayments'][number] | undefined): boolean {
  return attempt?.status === 'FAILED' &&
    attempt.failureCode !== 'MPESA_RESULT_4999' &&
    /^MPESA_RESULT_[1-9]\d*$/.test(attempt.failureCode ?? '') &&
    attempt.receiptReference === null;
}

function canPayApplicationFee(application: LoanApplication): boolean {
  if (application.processingFeePayments.some((attempt) =>
    attempt.status === 'PENDING' ||
    attempt.status === 'CONFIRMED' ||
    (attempt.status === 'FAILED' && attempt.failureCode === 'MPESA_RESULT_4999'),
  )) return false;
  if (application.processingFeePayments.length === 0) return application.status === 'DRAFT';
  return application.status === 'PROCESSING_PAYMENT_PENDING' &&
    isRetryableFeeFailure(application.processingFeePayments[0]);
}

function fieldError(name: string, value: string, product?: Product): string {
  if (!value.trim()) return 'This field is required.';
  if (name.endsWith('Name') && value.trim().replace(/\s+/g, ' ').length < 2) return 'Enter the full name.';
  if ((name.endsWith('Phone') || name === 'mpesaPhoneNumber') && !/^(?:\+?254|0)?[17]\d{8}$/.test(value.replace(/[\s()-]/g, ''))) {
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
  const [processingFeeQuoteError, setProcessingFeeQuoteError] = useState('');
  const [processingFeeQuoteLoading, setProcessingFeeQuoteLoading] = useState(true);
  const [applications, setApplications] = useState<LoanApplication[]>([]);
  const [applicationStatusError, setApplicationStatusError] = useState('');
  const [applicationStatusLoading, setApplicationStatusLoading] = useState(true);
  const [form, setForm] = useState<ApplicationForm>(emptyForm);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [reviewing, setReviewing] = useState(false);
  const [resumingApplicationId, setResumingApplicationId] = useState<string | null>(null);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [mpesaPhoneNumber, setMpesaPhoneNumber] = useState('');
  const [mpesaPhoneConfirmed, setMpesaPhoneConfirmed] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [acceptedOffers, setAcceptedOffers] = useState<Record<string, boolean>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [productsLoading, setProductsLoading] = useState(true);
  const [productsError, setProductsError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const creationKey = useRef<string | null>(null);
  const feeKey = useRef<string | null>(null);
  const paymentActionInFlight = useRef(false);
  const applicationsRequestSequence = useRef(0);
  const statusRequestSequence = useRef(0);

  const product = products.find((item) => item.id === form.productId);

  useEffect(() => {
    if (product) document.getElementById('apply-heading')?.scrollIntoView({ block: 'start' });
  }, [form.productId, product]);

  const refreshApplications = useCallback(async () => {
    const requestId = ++applicationsRequestSequence.current;
    const nextApplications = await apiRequest<LoanApplication[]>('/loans/applications', { cache: 'no-store' });
    if (requestId === applicationsRequestSequence.current) setApplications(nextApplications);
  }, []);

  const refreshPaymentStatus = useCallback(async () => {
    const requestId = ++statusRequestSequence.current;
    const applicationsRequestId = ++applicationsRequestSequence.current;
    setApplicationStatusLoading(true);
    setApplicationStatusError('');
    try {
      const result = await loadLoanApplicationStatus<LoanApplication>(apiRequest);
      if (requestId !== statusRequestSequence.current) return;
      setSignedIn(result.authenticated);
      if (!result.error && applicationsRequestId === applicationsRequestSequence.current) {
        setApplications(result.applications ?? []);
      }
      setApplicationStatusError(result.error);
      if (!result.error) setError('');
    } finally {
      if (requestId === statusRequestSequence.current) setApplicationStatusLoading(false);
    }
  }, []);

  async function refreshProducts() {
    setProductsLoading(true);
    setProductsError('');
    try {
      const availableProducts = await apiRequest<Product[]>('/loans/products', { cache: 'no-store' });
      setProducts(availableProducts);
      const selectedProductId = new URLSearchParams(window.location.search).get('productId');
      const selectedProduct = availableProducts.find((item) => item.id === selectedProductId);
      if (selectedProduct) setForm((current) => ({ ...current, productId: selectedProduct.id }));
    } catch (reason) {
      setProductsError(reason instanceof Error ? reason.message : 'Loan products could not be loaded.');
    } finally {
      setProductsLoading(false);
    }
  }

  async function refreshProcessingFeeQuote() {
    setProcessingFeeQuoteLoading(true);
    setProcessingFeeQuoteError('');
    try {
      setProcessingFeeQuote(await apiRequest<ProcessingFeeQuote>('/payments/loan-processing-fee-quote', { cache: 'no-store' }));
    } catch (reason) {
      setProcessingFeeQuoteError(reason instanceof Error ? reason.message : 'Processing-fee details could not be loaded.');
    } finally {
      setProcessingFeeQuoteLoading(false);
    }
  }

  useEffect(() => {
    void refreshProcessingFeeQuote();
    void refreshProducts();
    void refreshPaymentStatus().finally(() => setLoading(false));
    return () => {
      statusRequestSequence.current += 1;
      applicationsRequestSequence.current += 1;
    };
  }, [refreshPaymentStatus]);

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
    setTermsAccepted(false);
    setReviewing(true);
  }

  function selectProduct(selectedProduct: Product) {
    creationKey.current = null;
    feeKey.current = null;
    setResumingApplicationId(null);
    setForm({ ...emptyForm, productId: selectedProduct.id });
    setFieldErrors({});
    setTermsAccepted(false);
    setMpesaPhoneNumber('');
    setMpesaPhoneConfirmed(false);
    setReviewing(false);
    setError('');
  }

  const feeUnavailableReason = processingFeeQuoteError ||
    (!processingFeeQuote
      ? processingFeeQuoteLoading ? 'Processing-fee details are still loading.' : 'Processing-fee details are unavailable.'
      : processingFeeQuote.currency !== 'KES' || !Number.isSafeInteger(processingFeeQuote.amountKes)
        ? 'The processing-fee quote is invalid or unavailable. Contact support before continuing.'
        : !processingFeeQuote.paymentAvailable
          ? processingFeeQuote.unavailableReasons.join(' ') || 'Processing-fee payment is unavailable because a required policy, accounting, or M-Pesa prerequisite is incomplete.'
          : processingFeeQuote.refundPolicyStatus !== 'CONFIGURED' || !processingFeeQuote.refundPolicyDisclosure
            ? 'The approved processing-fee refund policy is not configured. An authorized operator must complete policy approval before payment is enabled.'
          : '');
  const feeQuoteAmount = processingFeeQuote?.currency === 'KES' &&
    Number.isSafeInteger(processingFeeQuote.amountKes) && processingFeeQuote.amountKes >= 0
    ? formatMoney(processingFeeQuote.amountKes)
    : processingFeeQuoteError ? 'Unavailable' : 'Loading quote…';

  async function payProcessingFee() {
    if (paymentActionInFlight.current) return;
    const phoneError = fieldError('mpesaPhoneNumber', mpesaPhoneNumber);
    if (phoneError || !mpesaPhoneConfirmed) {
      setError(phoneError || 'Confirm the M-Pesa number that should receive the payment prompt.');
      return;
    }
    if (!product || !signedIn || !termsAccepted || feeUnavailableReason || applicationStatusLoading || applicationStatusError) {
      setError(feeUnavailableReason || (!termsAccepted
        ? 'Accept the reviewed product terms before continuing.'
        : applicationStatusError || (applicationStatusLoading
          ? 'Checking saved applications and payment statuses. Wait for the check to complete before paying.'
          : 'Sign in to continue with this application.')));
      return;
    }
    paymentActionInFlight.current = true;
    setBusyId('new-application');
    setError('');
    setNotice('');
    try {
      let applicationId = resumingApplicationId;
      if (!applicationId) {
        if (!creationKey.current) creationKey.current = crypto.randomUUID();
        const application = await apiRequest<{ id: string }>('/loans/applications', {
          method: 'POST',
          headers: { 'Idempotency-Key': creationKey.current },
          body: JSON.stringify({
            ...form,
            requestedPrincipalKes: Number(form.requestedPrincipalKes),
            termsAccepted,
          }),
        });
        applicationId = application.id;
      }
      if (!feeKey.current) feeKey.current = crypto.randomUUID();
      const payment = await apiRequest<{ reference: string; status: string; message: string }>('/payments/loan-processing-fee', {
        method: 'POST',
        headers: { 'Idempotency-Key': feeKey.current },
        body: JSON.stringify({ applicationId, reviewConfirmed: true, mpesaPhoneNumber }),
      });
      setNotice(payment.message);
      creationKey.current = null;
      feeKey.current = null;
      setReviewing(false);
      setForm(emptyForm);
      setTermsAccepted(false);
      setMpesaPhoneNumber('');
      setMpesaPhoneConfirmed(false);
      setResumingApplicationId(null);
      await refreshApplications();
      await refreshPaymentStatus();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The processing-fee request could not be completed.');
      await refreshApplications().catch(() => undefined);
      await refreshPaymentStatus();
    } finally {
      paymentActionInFlight.current = false;
      setBusyId(null);
    }
  }

  function resumeProcessingFee(application: LoanApplication) {
    const applicationData = application.applicationData;
    const value = (key: string) => typeof applicationData[key] === 'string' ? applicationData[key] as string : '';
    creationKey.current = null;
    feeKey.current = null;
    setResumingApplicationId(application.id);
    setForm({
      productId: application.productId,
      requestedPrincipalKes: String(application.requestedPrincipalKes),
      guarantorOneName: value('guarantorOneName'),
      guarantorOnePhone: value('guarantorOnePhone'),
      guarantorTwoName: value('guarantorTwoName'),
      guarantorTwoPhone: value('guarantorTwoPhone'),
    });
    setFieldErrors({});
    setReviewing(true);
    setTermsAccepted(false);
    setMpesaPhoneNumber('');
    setMpesaPhoneConfirmed(false);
    setError('');
    setNotice('');
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
      {notice && <p className="admin-inline-notice" role="status">{notice}</p>}
      {error && <p className="admin-inline-error" role="alert">{error}</p>}
      {applicationStatusLoading && <p className="fee-unavailable-notice" role="status">Checking your saved applications and payment statuses.</p>}
      {applicationStatusError && <div className="fee-unavailable-notice" role="alert">
        <p>{applicationStatusError} <Link href="/login">Sign in</Link> or retry. Payment initiation remains disabled until this check succeeds.</p>
        <button className="quiet-button" type="button" disabled={busyId !== null || applicationStatusLoading} onClick={() => void refreshPaymentStatus()}>Retry status check</button>
      </div>}
      {!signedIn && !loading && <p className="product-list"><Link className="button" href="/login">Sign in to apply</Link></p>}
      {signedIn && product && (
        <section className="loan-application-panel" aria-labelledby="apply-heading">
          <div className="loan-application-title">
            <div><p className="eyebrow">SELECTED LOAN PRODUCT</p><h2 id="apply-heading">{reviewing ? 'Review your application' : product.name}</h2></div>
            <button className="quiet-button" type="button" disabled={busyId !== null} onClick={() => { creationKey.current = null; feeKey.current = null; setResumingApplicationId(null); setForm(emptyForm); setReviewing(false); setTermsAccepted(false); }}>Change product</button>
          </div>
          <ol className="loan-step-indicator" aria-label={`Application step ${reviewing ? 2 : 1} of 4`}>
            <li aria-current={!reviewing ? 'step' : undefined}><span>1</span><b>Details</b></li>
            <li aria-current={reviewing ? 'step' : undefined}><span>2</span><b>Review</b></li>
            <li><span>3</span><b>Payment</b></li>
            <li><span>4</span><b>Decision</b></li>
          </ol>
          {!reviewing ? (
            <form className="loan-application-form loan-application-guided" onSubmit={reviewApplication} noValidate>
              <input type="hidden" name="productId" value={product.id} />
              <p className="selected-product-summary">{product.description} <span>Terms version {product.termsVersion} · {product.durationDays} days · {(product.interestRateBps / 100).toFixed(2)}% flat over the full term.</span></p>
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
                <div><dt>Terms version</dt><dd>{product?.termsVersion}</dd></div>
                <div><dt>Requested amount</dt><dd>{formatMoney(Number(form.requestedPrincipalKes))}</dd></div>
                <div><dt>Guarantor 1</dt><dd>{form.guarantorOneName} · {form.guarantorOnePhone}</dd></div>
                <div><dt>Guarantor 2</dt><dd>{form.guarantorTwoName} · {form.guarantorTwoPhone}</dd></div>
                {product && Number.isSafeInteger(Number(form.requestedPrincipalKes)) && <>
                  <div><dt>Configured interest rate (flat, full term)</dt><dd>{(product.interestRateBps / 100).toFixed(2)}%</dd></div>
                  <div><dt>Repayment term</dt><dd>{product.durationDays} days</dd></div>
                  <div><dt>Repayment schedule</dt><dd>One repayment at the end of the term</dd></div>
                  <div><dt>Configured product fee</dt><dd>{formatMoney(product.flatFeeKes)}</dd></div>
                  <div><dt>Estimated total repayment</dt><dd>{(() => {
                    const estimate = estimateTotalRepayment(product, Number(form.requestedPrincipalKes));
                    return estimate === null ? 'Unavailable' : formatMoney(estimate);
                  })()}</dd></div>
                </>}
                <div><dt>Loan Processing Fee</dt><dd>{feeQuoteAmount}</dd></div>
              </dl>
              <p><b>Fee required:</b> A {feeQuoteAmount} loan processing fee is required before this application can be submitted. It covers processing this loan application and is paid separately from your loan repayment. Payment does not guarantee loan approval or disbursement. Your M-Pesa PIN is entered only in Safaricom’s prompt.</p>
              <label>M-Pesa phone number for the prompt
                <input type="tel" inputMode="tel" autoComplete="tel" placeholder="07XX XXX XXX" value={mpesaPhoneNumber} onChange={(event) => {
                  setMpesaPhoneNumber(event.target.value);
                  setMpesaPhoneConfirmed(false);
                }} aria-invalid={Boolean(mpesaPhoneNumber && fieldError('mpesaPhoneNumber', mpesaPhoneNumber))} required />
                <small>Enter the Kenyan number you want to use. It may be different from your account number.</small>
                {mpesaPhoneNumber && fieldError('mpesaPhoneNumber', mpesaPhoneNumber) && <small role="alert">{fieldError('mpesaPhoneNumber', mpesaPhoneNumber)}</small>}
              </label>
              <label className="check-row loan-terms-acceptance">
                <input type="checkbox" checked={mpesaPhoneConfirmed} onChange={(event) => setMpesaPhoneConfirmed(event.target.checked)} />
                <span>I confirm this is the M-Pesa number that should receive the displayed processing-fee prompt.</span>
              </label>
              <p>Estimates use the current configured product terms; an authorized approved offer may differ and must be reviewed before acceptance. The processing fee is not wallet funding.</p>
              {processingFeeQuote?.refundPolicyStatus === 'CONFIGURED' && processingFeeQuote.refundPolicyDisclosure && <p>{processingFeeQuote.refundPolicyDisclosure} <small>Policy version {processingFeeQuote.refundPolicyVersion}.</small></p>}
              {feeUnavailableReason && <div className="fee-unavailable-notice" role="status"><p>{feeUnavailableReason} Contact support if you need help; the fee will not be charged.</p>{processingFeeQuoteError && <button className="quiet-button" type="button" disabled={processingFeeQuoteLoading} onClick={() => void refreshProcessingFeeQuote()}>Retry fee quote</button>}</div>}
              <label className="check-row loan-terms-acceptance">
                <input type="checkbox" checked={termsAccepted} onChange={(event) => setTermsAccepted(event.target.checked)} />
                <span>I confirm my information is accurate, accept product terms version {product.termsVersion}, and authorize the displayed {feeQuoteAmount} processing fee to be requested via M-Pesa for this application. It is separate from loan repayment and does not guarantee approval or disbursement.</span>
              </label>
              <div className="loan-review-actions">
                <button className="quiet-button" type="button" disabled={busyId !== null} onClick={() => {
                  if (resumingApplicationId) {
                    setResumingApplicationId(null);
                    setForm(emptyForm);
                    setTermsAccepted(false);
                  }
                  setReviewing(false);
                }}>{resumingApplicationId ? 'Back to applications' : 'Edit details'}</button>
                <button className="button" type="button" disabled={busyId !== null || applicationStatusLoading || Boolean(applicationStatusError) || !termsAccepted || !mpesaPhoneConfirmed || Boolean(fieldError('mpesaPhoneNumber', mpesaPhoneNumber)) || Boolean(feeUnavailableReason)} onClick={() => void payProcessingFee()}>{busyId === 'new-application' ? 'Requesting payment…' : applicationStatusError ? 'Retry status check before payment' : applicationStatusLoading ? 'Checking payment status…' : `Pay ${feeQuoteAmount}`}</button>
              </div>
            </div>
          )}
        </section>
      )}
      <section className="product-list">
        <div className="product-list-heading"><p className="eyebrow">BORROWING OPTIONS</p><h2>Choose a loan product.</h2><p>Compare current configured terms before you apply. Product names, limits and charges are managed by LoanPlus. Paying a processing fee never guarantees approval or disbursement.</p></div>
        {productsLoading ? <p role="status">Loading configured loan products…</p> : productsError ? <div className="dashboard-empty" role="alert"><h2>Loan products could not be loaded.</h2><p>{productsError}</p><button className="quiet-button" type="button" onClick={() => void refreshProducts()}>Retry catalogue</button></div> : products.length === 0 ? <div className="dashboard-empty"><p className="eyebrow">NO PRODUCTS AVAILABLE</p><h2>There are no active loan products.</h2><p>Configured borrowing options will appear here when available.</p></div> : products.map((item) => (
          <article className="product-row" key={item.id}>
            <div><p className="eyebrow">{item.durationDays} DAY TERM</p><h2>{item.name}</h2><p>{item.description}</p></div>
            <dl>
              <div><dt>Principal range</dt><dd>{formatMoney(item.minimumPrincipalKes)} – {formatMoney(item.maximumPrincipalKes)}</dd></div>
              <div><dt>Interest (flat, full term)</dt><dd>{(item.interestRateBps / 100).toFixed(2)}%</dd></div>
              <div><dt>Duration</dt><dd>{item.durationDays} days</dd></div>
              <div><dt>Other configured charges</dt><dd>{formatMoney(item.flatFeeKes)}</dd></div>
              <div><dt>Loan processing fee</dt><dd>{feeQuoteAmount}</dd></div>
              <div><dt>Terms version</dt><dd>{item.termsVersion}</dd></div>
            </dl>
            {signedIn
              ? <button className="button button-small product-apply-button" type="button" onClick={() => selectProduct(item)}>Apply for {item.name}</button>
              : <Link className="button button-small product-apply-button" href="/login">Sign in to apply</Link>}
          </article>
        ))}
      </section>
      {signedIn && <section className="customer-ledger-list">
        <div className="customer-ledger-heading"><h2>My loan applications</h2><div><span>{applications.length}</span><button className="quiet-button" type="button" disabled={busyId !== null || applicationStatusLoading} onClick={() => void refreshPaymentStatus()}>Refresh status</button></div></div>
        {applications.length === 0 ? <p>No applications yet. Select a loan product and complete the application above.</p> : applications.map((application) => {
          const terms = application.approvedTermsSnapshot;
          const guarantor = (key: string) => typeof application.applicationData[key] === 'string' ? application.applicationData[key] as string : '—';
          const feeAttempts = application.processingFeePayments;
          const canPayFee = canPayApplicationFee(application);
          return (
            <article className="customer-loan-application" key={application.id}>
              <div><b>{terms?.productName ?? application.product.name}</b><small>Reference {application.id} · Requested {formatMoney(application.requestedPrincipalKes)}</small></div>
              <span className="status-label">{statusLabel(application)}</span>
              {canPayFee && <div className="draft-application-details">
                <p>Draft saved. Review the application details and continue to the processing-fee payment step.</p>
                {feeAttempts.length > 0 && <p>The previous attempt was conclusively declined. A new attempt will be recorded separately; the old payment history will remain available.</p>}
                <small>Guarantor 1: {guarantor('guarantorOneName')} · {guarantor('guarantorOnePhone')}</small>
                <small>Guarantor 2: {guarantor('guarantorTwoName')} · {guarantor('guarantorTwoPhone')}</small>
                <p>Loan Processing Fee — {feeQuoteAmount}. Paying it does not guarantee approval or disbursement and does not add funds to your wallet.</p>
                {feeUnavailableReason && <p className="fee-unavailable-notice" role="status">{feeUnavailableReason}</p>}
                {processingFeeQuoteError && <button className="quiet-button" type="button" disabled={processingFeeQuoteLoading} onClick={() => void refreshProcessingFeeQuote()}>Retry fee quote</button>}
                <button className="quiet-button" type="button" disabled={busyId !== null || applicationStatusLoading || Boolean(applicationStatusError)} onClick={() => resumeProcessingFee(application)}>{feeAttempts.length > 0 ? 'Review fee retry' : 'Review fee requirement'}</button>
              </div>}
              {feeAttempts.length > 0 && <dl>
                {feeAttempts.map((fee) => <div key={fee.id}>
                  <dt>Loan Processing Fee — {formatMoney(fee.amountKes)} · {fee.status === 'CONFIRMED'
                    ? 'Payment confirmed — application submitted for review'
                    : fee.status === 'PENDING'
                      ? 'Payment outcome pending verification — do not pay again'
                      : fee.status === 'FAILED' && fee.failureCode === 'MPESA_RESULT_4999'
                        ? 'Payment requires reconciliation — do not pay again'
                        : fee.status === 'FAILED'
                          ? 'Payment failed'
                          : fee.status.replaceAll('_', ' ')}</dt>
                  <dd>Reference {fee.internalReference}</dd>
                  {fee.confirmedAt && <dd>Confirmed {new Date(fee.confirmedAt).toLocaleString('en-KE')}</dd>}
                  {fee.receiptReference && <dd>M-Pesa receipt {fee.receiptReference}</dd>}
                  {(fee.status === 'PENDING' || fee.failureCode === 'MPESA_RESULT_4999') && <dd>Refresh the saved status or <Link href="/support">contact support</Link> for reconciliation. Do not create another attempt for this application while its outcome is uncertain.</dd>}
                  {fee.status === 'FAILED' && !isRetryableFeeFailure(fee) && <dd>Do not retry this fee without confirmation. <Link href="/support">Contact support</Link> for the verified next step.</dd>}
                </div>)}
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
