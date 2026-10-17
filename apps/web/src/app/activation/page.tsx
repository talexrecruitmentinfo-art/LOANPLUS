'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { apiRequest } from '@/lib/api';

interface ActivationTerms {
  available: boolean;
  availabilityReason: string | null;
  amountKes: number;
  currency: 'KES';
  terms: null | {
    purpose: string;
    refundability: string;
    creditedToWallet: boolean;
    customerDisclosure: string;
    termsVersion: string;
  };
}

interface Payment {
  paymentId: string;
  type: 'ACTIVATION';
  purpose: string;
  reference: string;
  status: 'PENDING' | 'CONFIRMED' | 'FAILED' | 'CANCELLED' | 'EXPIRED' | 'REVERSED';
  amountKes: number;
  currency: string;
  createdAt: string;
  updatedAt: string;
  providerResult: {
    code: number | null;
    receiptReference: string | null;
    message: string;
  };
  accountActivated: boolean;
  statusCheckMessage: string | null;
}

interface ActivationStatus {
  activationStatus: string;
  payment: Payment | null;
}

interface Wallet {
  balanceKes: number;
  currency: string;
}

interface CustomerProfile {
  phone: string;
}

const formatKes = (amount: number) => `KSh ${new Intl.NumberFormat('en-KE').format(amount)}`;

export default function ActivationPage() {
  const router = useRouter();
  const [terms, setTerms] = useState<ActivationTerms | null>(null);
  const [activation, setActivation] = useState<ActivationStatus | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [statusRefreshing, setStatusRefreshing] = useState(false);
  const [paymentAttemptUnresolved, setPaymentAttemptUnresolved] = useState(false);
  const [statusError, setStatusError] = useState('');
  const [phone, setPhone] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const refreshStatus = useCallback(async () => {
    const result = await apiRequest<ActivationStatus>('/payments/activation/status');
    setActivation(result);
    setStatusLoaded(true);
    setPaymentAttemptUnresolved((current) => current && !result.payment);
    setStatusError('');
    try {
      setWallet(await apiRequest<Wallet>('/wallet'));
    } catch {
      setWallet(null);
    }
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
        if (!cancelled) setStatusError(reason instanceof Error ? reason.message : 'Payment status could not be loaded.');
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [refreshStatus, router]);

  useEffect(() => {
    if (activation?.payment?.status !== 'PENDING') return;
    const timer = window.setInterval(() => {
      refreshStatus().catch((reason: unknown) => {
        setStatusError(reason instanceof Error ? reason.message : 'Payment status could not be refreshed.');
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
      const response = await apiRequest<{ message?: string }>('/payments/activation', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          phoneNumber: phone,
          termsAccepted: accepted,
          termsVersion: terms.terms.termsVersion,
        }),
      });
      setPaymentAttemptUnresolved(true);
      setMessage(response.message ?? 'The payment request was submitted. This does not confirm payment.');
      try {
        await refreshStatus();
      } catch {
        setStatusError('Payment status could not be refreshed. Do not submit another payment while the result is uncertain.');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The payment request could not be started.');
      setPaymentAttemptUnresolved(true);
      try {
        await refreshStatus();
      } catch {
        setStatusError('The payment outcome and current status could not be verified. Refresh status before trying again.');
      }
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
                  {terms.availabilityReason ?? (terms.terms
                    ? 'Payment provider configuration is incomplete.'
                    : 'Approved activation terms are not configured.')}
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
                <button
                  className="button"
                  disabled={
                    busy ||
                    !accepted ||
                    !statusLoaded ||
                    Boolean(statusError) ||
                    paymentPending ||
                    (paymentAttemptUnresolved && !activation?.payment)
                  }
                >
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
        {!statusLoaded && !statusError && <p>Loading your latest activation payment…</p>}
        {statusLoaded && !activation?.payment && (
          <section className="payment-status" aria-live="polite">
            <p className="eyebrow">LATEST ACTIVATION PAYMENT</p>
            <h2>No activation payment record</h2>
            <p>
              {paymentAttemptUnresolved
                ? 'The payment request may still be processing. Check its status before requesting another payment.'
                : 'A payment will appear here after a request is recorded.'}
            </p>
          </section>
        )}
        {activation?.payment && (
          <section className="payment-status" aria-live="polite">
            <p className="eyebrow">LATEST ACTIVATION PAYMENT</p>
            <div>
              <b>{formatKes(activation.payment.amountKes)}</b>
              <span className={`status-label status-${activation.payment.status.toLowerCase()}`}>
                {activation.payment.status}
              </span>
            </div>
            <p>{activation.payment.providerResult.message}</p>
            {activation.payment.statusCheckMessage && <p>{activation.payment.statusCheckMessage}</p>}
            <small>{activation.payment.purpose} · Reference {activation.payment.reference}</small>
            {activation.payment.providerResult.receiptReference && (
              <small>Safaricom receipt {activation.payment.providerResult.receiptReference}</small>
            )}
            <small>Created {new Date(activation.payment.createdAt).toLocaleString('en-KE')}</small>
            <small>
              Updated {new Date(activation.payment.updatedAt).toLocaleString('en-KE')}
            </small>
            {activation.payment.accountActivated && <p>Account activation is complete.</p>}
            {wallet && <small>Wallet balance: {formatKes(wallet.balanceKes)}</small>}
          </section>
        )}
        {(statusLoaded || statusError) && (
          <button
            type="button"
            className="quiet-button"
            disabled={statusRefreshing}
            onClick={async () => {
              setStatusRefreshing(true);
              setStatusError('');
              try {
                await refreshStatus();
              } catch (reason) {
                setStatusError(reason instanceof Error ? reason.message : 'Payment status could not be refreshed.');
              } finally {
                setStatusRefreshing(false);
              }
            }}
          >
            {statusRefreshing ? 'Refreshing…' : 'Refresh payment status'}
          </button>
        )}
        {statusError && <p className="form-error" role="alert">{statusError}</p>}
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
