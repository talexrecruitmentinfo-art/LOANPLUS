'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { apiRequest } from '@/lib/api';

interface ActivationTerms {
  available: boolean;
  amountKes: number;
  currency: 'KES';
  destination: null | {
    businessShortCode: string;
    transactionType: 'CustomerPayBillOnline' | 'CustomerBuyGoodsOnline';
  };
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
  status: 'PENDING' | 'CONFIRMED' | 'FAILED' | 'CANCELLED' | 'EXPIRED' | 'REVERSED';
  amountKes: number;
  currency: string;
  createdAt: string;
}

interface ActivationStatus {
  activationStatus: string;
  payment: Payment | null;
}

interface CustomerProfile {
  phone: string;
}

const formatKes = (amount: number) => `KSh ${new Intl.NumberFormat('en-KE').format(amount)}`;

const statusMessage: Record<Payment['status'], string> = {
  PENDING: 'Payment is awaiting provider confirmation. Check the phone entered above for the M-Pesa prompt. Do not submit another request while this one is pending.',
  CONFIRMED: 'M-Pesa confirmed this activation payment. Account activation is complete; this does not verify your identity or approve a loan.',
  FAILED: 'The provider did not confirm this payment. Your account has not been activated. Check your M-Pesa messages before trying again.',
  CANCELLED: 'The M-Pesa request was cancelled. Your account has not been activated.',
  EXPIRED: 'The M-Pesa request expired without confirmation. Your account has not been activated.',
  REVERSED: 'This payment was reversed. Your account is not activated by this payment.',
};

export default function ActivationPage() {
  const router = useRouter();
  const [terms, setTerms] = useState<ActivationTerms | null>(null);
  const [activation, setActivation] = useState<ActivationStatus | null>(null);
  const [phone, setPhone] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const refreshStatus = useCallback(async () => {
    const result = await apiRequest<ActivationStatus>('/payments/activation/status');
    setActivation(result);
    return result;
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      let customer: CustomerProfile;
      try {
        customer = await apiRequest<CustomerProfile>('/auth/me');
      } catch {
        router.replace('/login');
        return;
      }
      if (cancelled) return;
      setPhone(customer.phone);
      try {
        const configuredTerms = await apiRequest<ActivationTerms>('/payments/activation/terms');
        if (cancelled) return;
        setTerms(configuredTerms);
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : 'Activation details could not be loaded.');
        }
      }
      try {
        await refreshStatus();
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Payment status could not be loaded.');
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [refreshStatus, router]);

  useEffect(() => {
    if (activation?.payment?.status !== 'PENDING') return;
    const timer = window.setInterval(() => {
      refreshStatus().catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : 'Payment status could not be refreshed.');
      });
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [activation?.payment?.status, refreshStatus]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accepted || !terms?.available || !terms.terms) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await apiRequest<Payment & { message?: string }>('/payments/activation', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          phoneNumber: phone,
          termsAccepted: accepted,
          termsVersion: terms.terms.termsVersion,
        }),
      });
      setMessage(response.message ?? 'Check your phone for an M-Pesa prompt. Payment is not confirmed yet.');
      setActivation((current) => ({
        activationStatus: current?.activationStatus ?? 'PENDING',
        payment: {
          reference: response.reference,
          status: 'PENDING',
          amountKes: response.amountKes,
          currency: response.currency,
          createdAt: new Date().toISOString(),
        },
      }));
      try {
        await refreshStatus();
      } catch {
        setError('Payment is pending. Confirmation could not be refreshed yet; do not submit another request.');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The payment request could not be started.');
    } finally {
      setBusy(false);
    }
  }

  const paymentPending = activation?.payment?.status === 'PENDING';
  const isActive = activation?.activationStatus === 'ACTIVE';

  return (
    <main className="dashboard-page">
      <header className="dashboard-top">
        <Link className="wordmark" href="/dashboard"><span className="brand-mark">L+</span> loanplus</Link>
        <Link className="quiet-button" href="/dashboard">My account</Link>
      </header>
      <section className="dashboard-welcome">
        <p className="eyebrow">ACCOUNT ACTIVATION</p>
        <h1>{isActive ? 'Your account is active.' : 'Review before paying.'}</h1>
        <p>
          Account activation is separate from identity verification, credit assessment, and loan approval.
          Payment does not guarantee loan approval or disbursement.
        </p>
      </section>
      <section className="activation-content">
        {isActive ? (
          <div className="dashboard-empty">
            <p className="eyebrow">ACTIVATION CONFIRMED</p>
            <h2>Your account is active.</h2>
            <p>This confirms account activation only. Any loan application remains subject to eligibility and review.</p>
            <Link className="button" href="/loans">Continue to loan products <span aria-hidden="true">↗</span></Link>
          </div>
        ) : !terms ? (
          <p>Loading activation details…</p>
        ) : (
          <>
            <div className="activation-terms">
              <div>
                <p className="eyebrow">ACCOUNT ACTIVATION FEE</p>
                <strong>{formatKes(terms.amountKes)}</strong>
                <span>KES · {terms.terms?.termsVersion ?? 'Terms unavailable'}</span>
              </div>
              {terms.terms ? (
                <>
                  <dl>
                    <div><dt>Purpose</dt><dd>{terms.terms.purpose}</dd></div>
                    <div><dt>Refundability</dt><dd>{terms.terms.refundability.replaceAll('_', ' ').toLowerCase()}</dd></div>
                    <div><dt>Wallet treatment</dt><dd>{terms.terms.creditedToWallet ? 'Credited to your wallet' : 'Not credited to your wallet'}</dd></div>
                    {terms.destination && (
                      <div>
                        <dt>M-Pesa business destination</dt>
                        <dd>
                          {terms.destination.transactionType === 'CustomerBuyGoodsOnline' ? 'Till' : 'Paybill'}{' '}
                          {terms.destination.businessShortCode}
                        </dd>
                      </div>
                    )}
                  </dl>
                  <p>{terms.terms.customerDisclosure}</p>
                </>
              ) : (
                <p>Approved activation terms have not been configured. No payment request can be made.</p>
              )}
            </div>
            {!terms.available && (
              <div className="dashboard-empty">
                <p className="eyebrow">PAYMENT NOT AVAILABLE</p>
                <h2>Activation cannot be paid right now.</h2>
                <p>
                  {terms.terms
                    ? 'The payment provider or business destination is not configured for this environment.'
                    : 'Approved activation terms are not configured. No payment request has been created.'}
                  {' '}Contact LoanPlus support before retrying.
                </p>
              </div>
            )}
            {terms.available && terms.terms && (
              <form className="activation-form" onSubmit={submit}>
                <label>
                  Phone number to charge
                  <input
                    type="tel"
                    autoComplete="tel"
                    placeholder="07XX XXX XXX"
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                    minLength={9}
                    maxLength={16}
                    required
                  />
                </label>
                <label className="check-row">
                  <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} required />
                  <span>
                    I have reviewed the KES 50 activation fee, payment purpose, refundability, and terms version{' '}
                    {terms.terms.termsVersion}.
                  </span>
                </label>
                {error && <p className="form-error" role="alert">{error}</p>}
                <button className="button" disabled={busy || !accepted || paymentPending}>
                  {busy ? 'Requesting…' : 'Request M-Pesa prompt'} <span aria-hidden="true">↗</span>
                </button>
                <p className="activation-disclosure">
                  Check this phone for the Safaricom prompt and enter your M-Pesa PIN there. Never share your PIN.
                  A pending status is not payment confirmation; do not repeat a pending request.
                </p>
              </form>
            )}
          </>
        )}
        {error && !terms && <p className="form-error" role="alert">{error}</p>}
        {message && <p className="form-success" role="status">{message}</p>}
        {activation?.payment && (
          <section className="payment-status" aria-live="polite">
            <p className="eyebrow">LATEST ACTIVATION PAYMENT</p>
            <div>
              <b>{formatKes(activation.payment.amountKes)}</b>
              <span className={`status-label status-${activation.payment.status.toLowerCase()}`}>
                {activation.payment.status}
              </span>
            </div>
            <p>{statusMessage[activation.payment.status]}</p>
            <small>Reference {activation.payment.reference}</small>
          </section>
        )}
        {activation?.activationStatus !== 'ACTIVE' && (
          <p className="activation-support">
            Need help? Contact <a href="mailto:loanplus.info@gmail.com">loanplus.info@gmail.com</a> or{' '}
            <a href="tel:+254107052973">+254107052973</a>.
          </p>
        )}
      </section>
    </main>
  );
}
