'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { apiRequest } from '@/lib/api';

interface ActivationTerms {
  available: boolean;
  amountKes: number | null;
  terms: null | {
    purpose: string;
    refundability: string;
    creditedToWallet: boolean;
    customerDisclosure: string;
    termsVersion: string;
  };
}

interface Payment {
  reference: string;
  status: string;
  amountKes: number;
  currency: string;
  createdAt: string;
}

const formatKes = (amount: number) => `KSh ${new Intl.NumberFormat('en-KE').format(amount)}`;

export default function ActivationPage() {
  const router = useRouter();
  const [terms, setTerms] = useState<ActivationTerms | null>(null);
  const [payment, setPayment] = useState<Payment | null>(null);
  const [phone, setPhone] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function refreshStatus() {
    const payments = await apiRequest<Payment[]>('/payments');
    setPayment(payments.find((record) => record.status === 'PENDING') ?? payments[0] ?? null);
  }

  useEffect(() => {
    Promise.all([
      apiRequest('/auth/me'),
      apiRequest<ActivationTerms>('/payments/activation/terms'),
      refreshStatus(),
    ]).then(([, activationTerms]) => setTerms(activationTerms)).catch(() => router.replace('/login'));
  }, [router]);

  useEffect(() => {
    if (payment?.status !== 'PENDING') return;
    const timer = window.setInterval(() => {
      refreshStatus().catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [payment?.status]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accepted) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await apiRequest<Payment & { message?: string }>('/payments/activation', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ phoneNumber: phone, termsAccepted: accepted }),
      });
      setPayment({ ...response, createdAt: new Date().toISOString() });
      setMessage(response.message ?? 'Payment is pending provider confirmation.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The payment request could not be started.');
    } finally {
      setBusy(false);
    }
  }

  const statusMessage: Record<string, string> = {
    PENDING: 'Payment outcome is pending. Do not submit another request. We will update this status when reconciled.',
    CONFIRMED: 'The provider confirmed this payment and account activation is complete.',
    FAILED: 'The provider did not confirm this payment. Your account has not been activated.',
    CANCELLED: 'This payment was cancelled. Your account has not been activated.',
  };

  return <main className="dashboard-page"><header className="dashboard-top"><Link className="wordmark" href="/dashboard"><span className="brand-mark">L+</span> loanplus</Link><Link className="quiet-button" href="/dashboard">My account</Link></header><section className="dashboard-welcome"><p className="eyebrow">ACCOUNT ACTIVATION</p><h1>Review before paying.</h1><p>Payment does not guarantee loan approval or disbursement. Account activation is updated only after M-Pesa status reconciliation.</p></section><section className="activation-content">{!terms ? <p>Loading approved activation terms…</p> : !terms.available || !terms.terms ? <div className="dashboard-empty"><p className="eyebrow">PAYMENT NOT AVAILABLE</p><h2>Activation terms are not configured.</h2><p>No payment request has been created. Contact LoanPlus support when an approved activation policy is available.</p></div> : <><div className="activation-terms"><div><p className="eyebrow">CONFIGURED ACTIVATION AMOUNT</p><strong>{formatKes(terms.amountKes!)}</strong><span>KES · {terms.terms.termsVersion}</span></div><dl><div><dt>Purpose</dt><dd>{terms.terms.purpose}</dd></div><div><dt>Refundability</dt><dd>{terms.terms.refundability.replaceAll('_', ' ').toLowerCase()}</dd></div><div><dt>Wallet treatment</dt><dd>{terms.terms.creditedToWallet ? 'Credited to your wallet' : 'Not credited to your wallet'}</dd></div></dl><p>{terms.terms.customerDisclosure}</p></div><form className="activation-form" onSubmit={submit}><label>Phone number to charge<input type="tel" autoComplete="tel" placeholder="07XX XXX XXX" value={phone} onChange={(event) => setPhone(event.target.value)} minLength={9} maxLength={16} required /></label><label className="check-row"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} required /><span>I have reviewed the activation amount, purpose, refundability and terms version {terms.terms.termsVersion}.</span></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="button" disabled={busy || !accepted || payment?.status === 'PENDING'}>{busy ? 'Requesting…' : 'Request M-Pesa prompt'} <span aria-hidden="true">↗</span></button><p className="activation-disclosure">An M-Pesa request can fail or time out. A pending status is not a payment confirmation. Do not repeat a pending request.</p></form></>}{message && <p className="form-success" role="status">{message}</p>}{payment && <section className="payment-status"><p className="eyebrow">LATEST PAYMENT</p><div><b>{formatKes(payment.amountKes)}</b><span className={`status-label status-${payment.status.toLowerCase()}`}>{payment.status}</span></div><p>{statusMessage[payment.status] ?? 'This payment status is recorded by the server.'}</p><small>Reference {payment.reference}</small>{payment.status === 'FAILED' && <p>Start a new request only after checking that no M-Pesa payment was completed.</p>}</section>}</section></main>;
}