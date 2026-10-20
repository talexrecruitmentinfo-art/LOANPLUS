'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { apiRequest } from '@/lib/api';
import { formatMoney, PLATFORM_CURRENCY } from '@/lib/currency';
import { normalizeKenyanPhone } from '@/lib/kenyan-phone.mjs';
import {
  pollWalletDepositStatus,
  shouldClearWalletDepositTracking,
} from '@/lib/wallet-deposit-polling.mjs';

interface Wallet {
  balanceKes: number;
  pendingDepositsKes: number;
  currency: string;
}

interface WalletDepositQuote {
  currency: string;
  minimumAmountKes: number | null;
  maximumAmountKes: number | null;
  depositAvailable: boolean;
  unavailableReasons: string[];
}

interface WalletDepositEligibility {
  canInitiateNewDeposit: boolean;
  pendingDeposit: {
    reference: string;
    amountKes: number;
    currency: string;
    status: string;
    createdAt: string;
  } | null;
  message: string | null;
}

interface EligibleLoan {
  id: string;
  status: string;
  amountDueKes: number;
  principalDueKes: number;
  chargesDueKes: number;
  currency: string;
  dueAt: string | null;
}

interface WalletRepaymentReadiness {
  repaymentAvailable: boolean;
  unavailableReasons: string[];
}

interface LedgerEntry {
  id: string;
  debitKes: number;
  creditKes: number;
  createdAt: string;
  account: { code: string; name: string };
  transaction: { internalReference: string; transactionType: string; status: string };
}

interface LedgerPage {
  items: LedgerEntry[];
  nextCursor: string | null;
}

interface PaymentRecord {
  internalReference: string;
  type: string;
  amountKes: number;
  currency: string;
  status: string;
  receiptReference: string | null;
  unresolved?: boolean;
  createdAt: string;
  providerResult: { code: number | null; message: string };
}

interface WalletDepositStatus {
  reference: string;
  status: string;
}

interface WalletDepositStatusResponse {
  internalReference: string;
  status: string;
}

export default function CustomerLedger({ view }: { view: 'wallet' | 'transactions' }) {
  const router = useRouter();
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [nextEntryCursor, setNextEntryCursor] = useState<string | null>(null);
  const [loadingMoreEntries, setLoadingMoreEntries] = useState(false);
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [paymentHistoryVerified, setPaymentHistoryVerified] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [depositQuote, setDepositQuote] = useState<WalletDepositQuote | null>(null);
  const [depositQuoteError, setDepositQuoteError] = useState('');
  const [depositQuoteLoading, setDepositQuoteLoading] = useState(false);
  const [depositEligibility, setDepositEligibility] = useState<WalletDepositEligibility | null>(null);
  const [depositEligibilityError, setDepositEligibilityError] = useState('');
  const [depositEligibilityLoading, setDepositEligibilityLoading] = useState(false);
  const [eligibleLoans, setEligibleLoans] = useState<EligibleLoan[] | null>(null);
  const [repaymentReadiness, setRepaymentReadiness] = useState<WalletRepaymentReadiness | null>(null);
  const [serviceErrors, setServiceErrors] = useState<string[]>([]);
  const [depositAmount, setDepositAmount] = useState('');
  const [mpesaPhoneNumber, setMpesaPhoneNumber] = useState('');
  const [depositFormOpen, setDepositFormOpen] = useState(false);
  const [depositReference, setDepositReference] = useState('');
  const [selectedLoanId, setSelectedLoanId] = useState('');
  const [repaymentAmount, setRepaymentAmount] = useState('');
  const [walletActionBusy, setWalletActionBusy] = useState(false);
  const [walletActionMessage, setWalletActionMessage] = useState('');
  const [walletActionError, setWalletActionError] = useState('');
  const [depositStatus, setDepositStatus] = useState<WalletDepositStatus | null>(null);
  const [depositStatusError, setDepositStatusError] = useState('');
  const [depositStatusChecking, setDepositStatusChecking] = useState(false);
  const [depositPollingTimedOut, setDepositPollingTimedOut] = useState(false);
  const refreshSequence = useRef(0);
  const quoteSequence = useRef(0);
  const eligibilitySequence = useRef(0);
  const quoteController = useRef<AbortController | null>(null);
  const depositReferenceRef = useRef('');
  const depositPollingWindow = useRef<{ reference: string; startedAt: number; stopped: boolean } | null>(null);
  const statusCheckController = useRef<AbortController | null>(null);
  const statusCheckBusy = useRef(false);
  const walletActionBusyRef = useRef(false);
  const componentMounted = useRef(false);
  const applyDepositStatusRef = useRef<(reference: string, status: string) => Promise<void>>(async () => undefined);

  const refresh = useCallback(async () => {
    const requestId = ++refreshSequence.current;
    setRefreshing(true);
    setLoadingMoreEntries(false);
    setError('');
    try {
      const [nextWallet, nextEntries, nextPayments] = await Promise.all([
        apiRequest<Wallet>('/wallet', { cache: 'no-store' }),
        apiRequest<LedgerPage>('/wallet/transactions?limit=25', { cache: 'no-store' }),
        apiRequest<PaymentRecord[]>('/payments', { cache: 'no-store' }),
      ]);
      if (requestId !== refreshSequence.current) return;
      if (nextWallet.currency !== PLATFORM_CURRENCY.code) {
        throw new Error('The wallet currency does not match the supported platform currency.');
      }
      setWallet(nextWallet);
      setEntries(nextEntries.items);
      setNextEntryCursor(nextEntries.nextCursor);
      setPayments(nextPayments);
      setPaymentHistoryVerified(true);
      if (view === 'wallet') {
        const [loansResult, readinessResult] = await Promise.allSettled([
          apiRequest<EligibleLoan[]>('/loans/repayments/eligible', { cache: 'no-store' }),
          apiRequest<WalletRepaymentReadiness>('/loans/repayments/readiness', { cache: 'no-store' }),
        ]);
        if (requestId !== refreshSequence.current) return;
        const errors: string[] = [];
        if (loansResult.status === 'fulfilled') setEligibleLoans(loansResult.value);
        else {
          setEligibleLoans(null);
          errors.push(loansResult.reason instanceof Error ? loansResult.reason.message : 'Eligible loans could not be loaded.');
        }
        if (readinessResult.status === 'fulfilled') setRepaymentReadiness(readinessResult.value);
        else {
          setRepaymentReadiness(null);
          errors.push(readinessResult.reason instanceof Error ? readinessResult.reason.message : 'Wallet repayment availability could not be checked.');
        }
        setServiceErrors(errors);
        if (loansResult.status === 'fulfilled' && !loansResult.value.some((loan) => loan.id === selectedLoanId)) {
          const nextLoan = loansResult.value[0];
          setSelectedLoanId(nextLoan?.id ?? '');
          setRepaymentAmount(nextLoan ? String(nextLoan.amountDueKes) : '');
        }
      }
      return nextPayments;
    } catch (reason) {
      if (requestId !== refreshSequence.current) return;
      setPaymentHistoryVerified(false);
      if (reason instanceof Error && reason.message.includes('Authentication required')) {
        router.replace('/login');
      }
      setError(reason instanceof Error ? reason.message : 'Account activity could not be loaded.');
      return null;
    } finally {
      if (requestId === refreshSequence.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [router, selectedLoanId, view]);

  const loadDepositQuote = useCallback(async () => {
    const requestId = ++quoteSequence.current;
    quoteController.current?.abort();
    const controller = new AbortController();
    quoteController.current = controller;
    setDepositQuoteLoading(true);
    setDepositQuoteError('');
    try {
      const quote = await apiRequest<WalletDepositQuote>('/payments/wallet-deposit-quote', {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (requestId !== quoteSequence.current || controller.signal.aborted) return;
      setDepositQuote(quote);
    } catch (reason) {
      if (requestId !== quoteSequence.current || controller.signal.aborted) return;
      setDepositQuote(null);
      setDepositQuoteError(reason instanceof Error
        ? reason.message
        : 'Deposit availability could not be checked.');
    } finally {
      if (requestId === quoteSequence.current && !controller.signal.aborted) {
        setDepositQuoteLoading(false);
        quoteController.current = null;
      }
    }
  }, []);

  const loadDepositEligibility = useCallback(async () => {
    const requestId = ++eligibilitySequence.current;
    setDepositEligibilityLoading(true);
    setDepositEligibilityError('');
    try {
      const eligibility = await apiRequest<WalletDepositEligibility>(
        '/payments/wallet-deposit-eligibility',
        { cache: 'no-store' },
      );
      if (requestId !== eligibilitySequence.current) return null;
      setDepositEligibility(eligibility);
      return eligibility;
    } catch (reason) {
      if (requestId !== eligibilitySequence.current) return null;
      setDepositEligibility(null);
      setDepositEligibilityError(reason instanceof Error
        ? reason.message
        : 'Deposit retry eligibility could not be checked.');
      return null;
    } finally {
      if (requestId === eligibilitySequence.current) setDepositEligibilityLoading(false);
    }
  }, []);

  const loadMoreEntries = useCallback(async () => {
    if (!nextEntryCursor || loadingMoreEntries) return;
    const requestId = refreshSequence.current;
    setLoadingMoreEntries(true);
    try {
      const page = await apiRequest<LedgerPage>(
        `/wallet/transactions?limit=25&cursor=${encodeURIComponent(nextEntryCursor)}`,
        { cache: 'no-store' },
      );
      if (requestId !== refreshSequence.current) return;
      setEntries((current) => [...current, ...page.items]);
      setNextEntryCursor(page.nextCursor);
    } catch (reason) {
      if (requestId === refreshSequence.current) {
        setError(reason instanceof Error ? reason.message : 'More wallet transactions could not be loaded.');
      }
    } finally {
      if (requestId === refreshSequence.current) setLoadingMoreEntries(false);
    }
  }, [loadingMoreEntries, nextEntryCursor]);

  useEffect(() => {
    void refresh();
    return () => { refreshSequence.current += 1; };
  }, [refresh]);

  useEffect(() => {
    if (view !== 'wallet') return;
    void loadDepositQuote();
    return () => {
      quoteSequence.current += 1;
      quoteController.current?.abort();
      quoteController.current = null;
      setDepositQuoteLoading(false);
    };
  }, [loadDepositQuote, view]);

  useEffect(() => {
    if (view !== 'wallet') return;
    void loadDepositEligibility();
    return () => { eligibilitySequence.current += 1; };
  }, [loadDepositEligibility, view]);

  const filteredEntries = useMemo(() => entries.filter((entry) => {
    const query = search.trim().toLowerCase();
    const matchesQuery = !query || [
      entry.transaction.internalReference,
      entry.transaction.transactionType,
      entry.account.name,
    ].some((value) => value.toLowerCase().includes(query));
    const matchesStatus = statusFilter === 'ALL' || entry.transaction.status === statusFilter;
    return matchesQuery && matchesStatus;
  }), [entries, search, statusFilter]);

  const title = view === 'wallet' ? 'Your wallet.' : 'Account activity.';
  const visibleEntries = view === 'wallet' ? filteredEntries.slice(0, 6) : filteredEntries;
  const selectedLoan = eligibleLoans?.find((loan) => loan.id === selectedLoanId);
  const unresolvedDepositRecord = payments
    .filter((payment) => payment.type === 'WALLET_DEPOSIT' &&
      (payment.status === 'PENDING' || payment.unresolved))
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))[0];
  const unresolvedDepositReference =
    depositEligibility?.pendingDeposit?.reference ??
    (depositEligibility?.canInitiateNewDeposit === false || depositEligibility === null
      ? unresolvedDepositRecord?.internalReference
      : undefined);
  const selectedDepositReference = unresolvedDepositReference || depositReference;
  const trackedDeposit = payments.find((payment) => payment.internalReference === selectedDepositReference);
  const eligibilityReleased = depositEligibility?.canInitiateNewDeposit === true &&
    depositEligibility.pendingDeposit === null;
  const trackedTerminalStatus = trackedDeposit &&
    ['CONFIRMED', 'FAILED', 'CANCELLED', 'EXPIRED', 'REVERSED'].includes(trackedDeposit.status)
    ? trackedDeposit.status
    : null;
  const displayedDepositStatus = eligibilityReleased
    ? trackedTerminalStatus ??
      (depositStatus?.reference === selectedDepositReference && depositStatus.status !== 'PENDING'
        ? depositStatus.status
        : null)
    : trackedTerminalStatus ??
      (depositStatus?.reference === selectedDepositReference
        ? depositStatus.status
        : depositEligibility?.pendingDeposit?.status ?? unresolvedDepositRecord?.status ?? null);

  useEffect(() => {
    const trackedPayment = payments.find((payment) => payment.internalReference === depositReference);
    if (!shouldClearWalletDepositTracking({
      reference: depositReference,
      paymentStatus: trackedPayment?.status ?? null,
      canInitiateNewDeposit: eligibilityReleased,
    })) return;
    if (depositPollingWindow.current?.reference === depositReference) {
      depositPollingWindow.current.stopped = true;
    }
    depositReferenceRef.current = '';
    depositPollingWindow.current = null;
    setDepositReference('');
    setDepositStatus((current) => current?.reference === depositReference ? null : current);
    setDepositPollingTimedOut(false);
    setDepositStatusError('');
  }, [depositEligibility, depositReference, eligibilityReleased, payments]);

  const applyDepositStatus = useCallback(async (reference: string, status: string) => {
    if (!componentMounted.current || depositReferenceRef.current !== reference) return;
    const terminalStatus = ['CONFIRMED', 'FAILED', 'CANCELLED', 'EXPIRED', 'REVERSED'].includes(status);
    if (status !== 'PENDING' && !terminalStatus) {
      setDepositStatusError('The deposit status response was not recognized. Check its status again.');
      return;
    }
    setDepositStatus({ reference, status });
    setDepositStatusError('');
    if (status === 'PENDING') return;

    const pollingWindow = depositPollingWindow.current;
    if (pollingWindow?.reference === reference) pollingWindow.stopped = true;
    setDepositPollingTimedOut(false);
    const refreshedPayments = await refresh();
    await loadDepositEligibility();
    if (!componentMounted.current || depositReferenceRef.current !== reference) return;
    if (!refreshedPayments) {
      setDepositStatusError('The payment status was received, but wallet activity could not be refreshed. Check status again.');
      return;
    }
    const refreshedDeposit = refreshedPayments.find((payment) => payment.internalReference === reference);
    if (status === 'CONFIRMED') {
      setDepositFormOpen(false);
      setDepositAmount('');
      setMpesaPhoneNumber('');
      setWalletActionError('');
      setWalletActionMessage(
        `${formatMoney(refreshedDeposit?.amountKes ?? trackedDeposit?.amountKes ?? 0)} deposit confirmed and added to your wallet.`,
      );
    } else if (status === 'FAILED' || status === 'CANCELLED' || status === 'EXPIRED' || status === 'REVERSED') {
      setWalletActionMessage('');
      setWalletActionError(
        refreshedDeposit?.providerResult.message ||
        `The deposit ${status.toLowerCase()}.`,
      );
    }
  }, [loadDepositEligibility, refresh, trackedDeposit?.amountKes]);
  applyDepositStatusRef.current = applyDepositStatus;

  useEffect(() => {
    if (view !== 'wallet' || !unresolvedDepositReference ||
      depositReferenceRef.current === unresolvedDepositReference) return;
    const reference = unresolvedDepositReference;
    depositReferenceRef.current = reference;
    statusCheckController.current?.abort();
    statusCheckController.current = null;
    statusCheckBusy.current = false;
    setDepositStatusChecking(false);
    depositPollingWindow.current = { reference, startedAt: Date.now(), stopped: false };
    setDepositReference(reference);
    setDepositStatus({
      reference,
      status: depositEligibility?.pendingDeposit?.status ?? unresolvedDepositRecord?.status ?? 'PENDING',
    });
  }, [depositEligibility?.pendingDeposit?.status, unresolvedDepositRecord?.status, unresolvedDepositReference, view]);

  useEffect(() => {
    if (view !== 'wallet' || !selectedDepositReference || displayedDepositStatus !== 'PENDING') return;
    if (depositReferenceRef.current !== selectedDepositReference) return;
    let pollingWindow = depositPollingWindow.current;
    if (!pollingWindow || pollingWindow.reference !== selectedDepositReference) {
      pollingWindow = { reference: selectedDepositReference, startedAt: Date.now(), stopped: false };
      depositPollingWindow.current = pollingWindow;
    }
    if (pollingWindow.stopped) return;

    const controller = new AbortController();
    const reference = selectedDepositReference;
    setDepositPollingTimedOut(false);
    void pollWalletDepositStatus({
      reference,
      startedAt: pollingWindow.startedAt,
      signal: controller.signal,
      getStatus: (paymentReference, signal) => apiRequest<WalletDepositStatusResponse>(
        `/payments/wallet-deposits/${encodeURIComponent(paymentReference)}`,
        { cache: 'no-store', signal },
      ),
      onStatus: (result) => applyDepositStatusRef.current(reference, result.status),
    }).then((result) => {
      if (!componentMounted.current || depositReferenceRef.current !== reference || controller.signal.aborted) return;
      if (result === 'timeout') {
        const current = depositPollingWindow.current;
        if (current?.reference === reference) current.stopped = true;
        setDepositPollingTimedOut(true);
      }
    }).catch((reason: unknown) => {
      if (!componentMounted.current || depositReferenceRef.current !== reference || controller.signal.aborted) return;
      const current = depositPollingWindow.current;
      if (current?.reference === reference) current.stopped = true;
      setDepositStatusError(reason instanceof Error
        ? reason.message
        : 'The deposit status could not be checked. Try again.');
    });
    return () => controller.abort();
  }, [displayedDepositStatus, selectedDepositReference, view]);

  useEffect(() => () => {
    componentMounted.current = false;
    statusCheckController.current?.abort();
    statusCheckController.current = null;
    statusCheckBusy.current = false;
  }, []);
  useEffect(() => {
    componentMounted.current = true;
    return () => { componentMounted.current = false; };
  }, []);

  async function checkDepositStatus(reference: string) {
    if (statusCheckBusy.current || depositReferenceRef.current !== reference) return;
    statusCheckBusy.current = true;
    setDepositStatusChecking(true);
    setDepositStatusError('');
    const controller = new AbortController();
    statusCheckController.current?.abort();
    statusCheckController.current = controller;
    try {
      const result = await apiRequest<WalletDepositStatusResponse>(
        `/payments/wallet-deposits/${encodeURIComponent(reference)}`,
        { cache: 'no-store', signal: controller.signal },
      );
      if (!componentMounted.current || controller.signal.aborted || depositReferenceRef.current !== reference) return;
      await applyDepositStatus(reference, result.status);
    } catch (reason) {
      if (!componentMounted.current || controller.signal.aborted || depositReferenceRef.current !== reference) return;
      setDepositStatusError(reason instanceof Error
        ? reason.message
        : 'The deposit status could not be checked. Try again.');
    } finally {
      if (statusCheckController.current === controller) {
        statusCheckController.current = null;
        statusCheckBusy.current = false;
        setDepositStatusChecking(false);
      }
    }
  }

  async function submitDeposit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (walletActionBusyRef.current || statusCheckBusy.current || !paymentHistoryVerified) return;
    const amountKes = Number(depositAmount);
    if (!Number.isSafeInteger(amountKes) || amountKes <= 0 || !depositQuote?.depositAvailable) return;
    const normalizedPhoneNumber = normalizeKenyanPhone(mpesaPhoneNumber);
    if (!normalizedPhoneNumber) {
      setWalletActionError('Enter a valid Kenyan M-Pesa phone number.');
      return;
    }
    if (amountKes < (depositQuote.minimumAmountKes ?? Number.POSITIVE_INFINITY) ||
      amountKes > (depositQuote.maximumAmountKes ?? 0)) {
      setWalletActionError('Enter an amount within the approved wallet deposit limits.');
      return;
    }
    if (!window.confirm(`Confirm an M-Pesa wallet deposit of ${formatMoney(amountKes)}?`)) return;
    walletActionBusyRef.current = true;
    setWalletActionBusy(true);
    setWalletActionError('');
    setWalletActionMessage('');
    try {
      const eligibility = await loadDepositEligibility();
      if (!eligibility) throw new Error('Deposit retry eligibility could not be checked.');
      if (!eligibility.canInitiateNewDeposit) {
        throw new Error(eligibility.message || 'A previous wallet deposit remains unresolved.');
      }
      await apiRequest<WalletDepositQuote>(
        `/payments/wallet-deposit-quote?amountKes=${encodeURIComponent(amountKes)}`,
        { cache: 'no-store' },
      );
      const result = await apiRequest<{ reference: string; status: string; message: string }>('/payments/wallet-deposits', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ amountKes, mpesaPhoneNumber: normalizedPhoneNumber }),
      });
      depositReferenceRef.current = result.reference;
      setDepositReference(result.reference);
      setDepositStatus({ reference: result.reference, status: result.status });
      setDepositStatusError('');
      setDepositPollingTimedOut(false);
      depositPollingWindow.current = result.status === 'PENDING'
        ? { reference: result.reference, startedAt: Date.now(), stopped: false }
        : { reference: result.reference, startedAt: Date.now(), stopped: true };
      await loadDepositEligibility();
      setWalletActionMessage('');
      if (result.status !== 'PENDING') {
        const refreshedPayments = await refresh();
        if (result.status === 'FAILED') {
          const failedPayment = refreshedPayments?.find((payment) => payment.internalReference === result.reference);
          setWalletActionError(failedPayment?.providerResult.message || result.message);
        }
      }
    } catch (reason) {
      setWalletActionError(reason instanceof Error ? reason.message : 'The wallet deposit could not be started.');
    } finally {
      walletActionBusyRef.current = false;
      setWalletActionBusy(false);
    }
  }

  function cancelDepositForm() {
    setDepositFormOpen(false);
    setDepositAmount('');
    setMpesaPhoneNumber('');
    setWalletActionError('');
    if (!depositReferenceRef.current) setWalletActionMessage('');
  }

  async function submitRepayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amountKes = Number(repaymentAmount);
    if (!selectedLoan || !Number.isSafeInteger(amountKes) || amountKes <= 0 ||
      amountKes > selectedLoan.amountDueKes || !repaymentReadiness?.repaymentAvailable) return;
    if (!window.confirm(`Confirm a wallet repayment of ${formatMoney(amountKes)} to loan ${selectedLoan.id}?`)) return;
    setWalletActionBusy(true);
    setWalletActionError('');
    setWalletActionMessage('');
    try {
      const receipt = await apiRequest<{
        reference: string;
        amountKes: number;
        outstandingKes: number;
        status: string;
      }>(`/loans/${encodeURIComponent(selectedLoan.id)}/repayments`, {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ amountKes, confirmed: true }),
      });
      setWalletActionMessage(
        `Repayment receipt ${receipt.reference}: ${formatMoney(receipt.amountKes)} applied. Remaining due ${formatMoney(receipt.outstandingKes)} · ${receipt.status}.`,
      );
      await refresh();
    } catch (reason) {
      setWalletActionError(reason instanceof Error ? reason.message : 'The wallet repayment could not be completed.');
    } finally {
      setWalletActionBusy(false);
    }
  }

  return (
    <main className="dashboard-page customer-ledger-page">
      <header className="dashboard-top">
        <Link className="wordmark" href="/dashboard"><span className="brand-mark">L+</span> loanplus</Link>
        <Link className="quiet-button" href="/profile">My account</Link>
      </header>
      <section className="dashboard-welcome">
        <p className="eyebrow">{view === 'wallet' ? 'AVAILABLE BALANCE' : 'POSTED WALLET ACTIVITY'}</p>
        <h1>{title}</h1>
        <p>Amounts and entries are read from your authenticated KES ledger.</p>
      </section>
      {error && <p className="form-error" role="alert">{error}</p>}
      {view === 'wallet' && (
        <section className="customer-balance-band" aria-live="polite">
          <span>Available balance</span>
          <strong>{wallet ? formatMoney(wallet.balanceKes) : loading ? 'Loading…' : 'Unavailable'}</strong>
          <span>Pending deposits: {wallet ? formatMoney(wallet.pendingDepositsKes) : loading ? 'Loading…' : 'Unavailable'}</span>
          <small>Available in {PLATFORM_CURRENCY.name} · {PLATFORM_CURRENCY.code}</small>
        </section>
      )}
      {view === 'wallet' && <section className="wallet-actions" aria-label="Wallet services">
        <div className="wallet-deposit-heading">
          <div><h2>Deposit with M-Pesa</h2><p>Wallet funds are added after verified payment confirmation.</p></div>
          <button className="button" type="button" aria-expanded={depositFormOpen} aria-controls="wallet-deposit-form" onClick={() => {
            setDepositFormOpen(true);
            void loadDepositQuote();
            void loadDepositEligibility();
          }}>Deposit</button>
        </div>
        {depositQuoteLoading && <p role="status">Checking whether wallet deposits are available…</p>}
        {depositQuoteError && <div className="form-error" role="alert">
          <p>{depositQuoteError}</p>
          <button className="quiet-button" type="button" disabled={depositQuoteLoading} onClick={() => void loadDepositQuote()}>
            {depositQuoteLoading ? 'Checking…' : 'Retry availability check'}
          </button>
        </div>}
        {!depositQuoteLoading && !depositQuoteError && depositQuote && (
          <p className={depositQuote.depositAvailable ? 'wallet-action-success' : 'form-error'} role="status">
            {depositQuote.depositAvailable
              ? `Deposits are available${depositQuote.minimumAmountKes !== null && depositQuote.maximumAmountKes !== null
                ? ` from ${formatMoney(depositQuote.minimumAmountKes)} to ${formatMoney(depositQuote.maximumAmountKes)}`
                : ''}.`
              : 'Wallet deposits are currently unavailable.'}
          </p>
        )}
        {depositEligibilityError && <div className="form-error" role="alert">
          <p>{depositEligibilityError}</p>
          <button className="quiet-button" type="button" disabled={depositEligibilityLoading}
              onClick={() => void loadDepositEligibility()}>
              {depositEligibilityLoading ? 'Checking…' : 'Retry deposit eligibility check'}
          </button>
        </div>}
        {depositQuote && !depositQuoteLoading && depositQuote.unavailableReasons.map((reason) =>
          <p className="form-error" role="status" key={reason}>{reason}</p>)}
        {selectedDepositReference && displayedDepositStatus && <div className="wallet-deposit-pending" aria-live="polite">
          <p role="status">
            {displayedDepositStatus === 'PENDING'
              ? depositPollingTimedOut
                ? `Previous deposit ${selectedDepositReference} remains unresolved. Automatic checking has stopped; it may still complete. A new deposit is unavailable until safely resolved.`
                : `Previous deposit ${selectedDepositReference} is awaiting Safaricom confirmation. Automatic checking runs for up to 1 minute; a new deposit is unavailable until safely resolved.`
              : `Payment status: ${displayedDepositStatus?.replaceAll('_', ' ') ?? 'being checked'} · Reference ${selectedDepositReference}.`}
          </p>
          {depositStatusError && <p className="form-error" role="alert">{depositStatusError}</p>}
          {displayedDepositStatus === 'PENDING' && <>
            <button className="quiet-button" type="button" disabled={depositStatusChecking}
              onClick={() => void checkDepositStatus(selectedDepositReference)}>
              {depositStatusChecking ? 'Checking status…' : 'Check status'}
            </button>
            {' '}<Link className="quiet-button" href="/support">Request payment reconciliation</Link>
          </>}
        </div>}
        {walletActionMessage && <p className="wallet-action-success" role="status">{walletActionMessage}</p>}
        {walletActionError && <p className="form-error" role="alert">{walletActionError}</p>}
        {depositFormOpen && <section className="wallet-deposit-panel" id="wallet-deposit-form" aria-labelledby="wallet-deposit-form-heading">
          <div className="wallet-deposit-panel-heading"><h3 id="wallet-deposit-form-heading">Deposit with M-Pesa</h3><button className="quiet-button" type="button" disabled={walletActionBusy} onClick={cancelDepositForm}>Cancel</button></div>
          {depositQuote && <small>
            {depositQuote.minimumAmountKes !== null && depositQuote.maximumAmountKes !== null
              ? `Allowed amount: ${formatMoney(depositQuote.minimumAmountKes)}–${formatMoney(depositQuote.maximumAmountKes)}.`
              : 'Deposit limits are not configured.'}
          </small>}
          <form className="wallet-action-form" onSubmit={submitDeposit}>
            <label>Deposit amount (KES)
              <input type="number" min={depositQuote?.minimumAmountKes ?? undefined} max={depositQuote?.maximumAmountKes ?? undefined} step="1" value={depositAmount} onChange={(event) => setDepositAmount(event.target.value)} required />
            </label>
            <label>M-Pesa phone number
              <input type="tel" inputMode="tel" autoComplete="tel" value={mpesaPhoneNumber} onChange={(event) => setMpesaPhoneNumber(event.target.value)} placeholder="+2547…" maxLength={16} pattern="\+?[\d\x20\x28\x29\x2D]{9,16}" title="Enter a valid Kenyan M-Pesa phone number" required />
            </label>
            <div className="wallet-deposit-actions">
                      <button className="button" type="submit" disabled={walletActionBusy || loading || depositQuoteLoading ||
                Boolean(depositQuoteError) || !depositQuote?.depositAvailable ||
                depositEligibilityLoading || Boolean(depositEligibilityError) ||
                depositEligibility?.canInitiateNewDeposit !== true ||
                depositStatusChecking || !paymentHistoryVerified}>
                {walletActionBusy ? 'Starting…' : 'Continue to M-Pesa'}
              </button>
              <button className="quiet-button" type="button" disabled={walletActionBusy} onClick={cancelDepositForm}>Cancel</button>
            </div>
          </form>
        </section>}
        {serviceErrors.map((reason) => <p className="form-error" role="alert" key={reason}>{reason}</p>)}
        <h2>Repay a loan from your wallet</h2>
        {repaymentReadiness?.unavailableReasons.map((reason) => <p className="form-error" role="status" key={reason}>{reason}</p>)}
        {eligibleLoans?.length === 0 && <p>No disbursed loan is currently eligible for wallet repayment.</p>}
        {eligibleLoans && eligibleLoans.length > 0 && selectedLoan && (
          <form className="wallet-action-form" onSubmit={submitRepayment}>
            <label>Loan<select value={selectedLoanId} onChange={(event) => {
              const loan = eligibleLoans.find((item) => item.id === event.target.value);
              setSelectedLoanId(event.target.value);
              setRepaymentAmount(loan ? String(loan.amountDueKes) : '');
            }}>
              {eligibleLoans.map((loan) => <option key={loan.id} value={loan.id}>
                {loan.id} · {loan.status.replaceAll('_', ' ')} · due {formatMoney(loan.amountDueKes)}
              </option>)}
            </select></label>
            <p>Amount due {formatMoney(selectedLoan.amountDueKes)} · available wallet balance {formatMoney(wallet?.balanceKes ?? 0)}.</p>
            <label>Repayment amount (KES)
              <input type="number" min="1" max={selectedLoan.amountDueKes} step="1" value={repaymentAmount} onChange={(event) => setRepaymentAmount(event.target.value)} required />
            </label>
            <p>Repayments are applied to outstanding charges first, then principal. Partial repayments are allowed.</p>
            <button className="button" type="submit" disabled={walletActionBusy || loading || eligibleLoans === null || !repaymentReadiness?.repaymentAvailable || !wallet || Number(repaymentAmount) > wallet.balanceKes}>
              {walletActionBusy ? 'Processing…' : 'Review and repay'}
            </button>
          </form>
        )}
      </section>}
      {view === 'transactions' && (
        <section className="customer-filter-row" aria-label="Filter account activity">
          <label>Search activity<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Reference or type" /></label>
          <label>Status<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="ALL">All statuses</option>
            <option value="POSTED">Posted</option>
            <option value="REVERSED">Reversed</option>
          </select></label>
        </section>
      )}
      <section className="customer-ledger-list" aria-label={view === 'wallet' ? 'Recent wallet activity' : 'Account transactions'}>
        <div className="customer-ledger-heading">
          <h2>{view === 'wallet' ? 'Recent activity' : 'Transactions'}</h2>
          <button className="quiet-button" type="button" disabled={refreshing} onClick={() => void refresh()}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        {loading ? <p>Loading ledger activity…</p> : visibleEntries.length === 0 ? (
          <div className="customer-ledger-empty"><h3>No wallet transactions yet</h3><p>Verified wallet activity will appear here when recorded by LoanPlus.</p></div>
        ) : visibleEntries.map((entry) => {
          const incoming = entry.creditKes > 0;
          const amount = incoming ? entry.creditKes : entry.debitKes;
          return (
            <article className="customer-ledger-row" key={entry.id}>
              <div className="customer-ledger-primary">
                <b>{entry.transaction.transactionType.replaceAll('_', ' ')}</b>
                <small>Ref {entry.transaction.internalReference.slice(-8)} · {new Date(entry.createdAt).toLocaleDateString(PLATFORM_CURRENCY.locale)}</small>
                <details className="transaction-details">
                  <summary>Details</summary>
                  <dl>
                    <div><dt>Reference</dt><dd>{entry.transaction.internalReference}</dd></div>
                    <div><dt>Ledger account</dt><dd>{entry.account.name} ({entry.account.code})</dd></div>
                    <div><dt>Recorded</dt><dd>{new Date(entry.createdAt).toLocaleString(PLATFORM_CURRENCY.locale)}</dd></div>
                  </dl>
                </details>
              </div>
              <strong className={incoming ? 'ledger-credit' : 'ledger-debit'}>
                {incoming ? '+' : '−'}{formatMoney(amount)}
              </strong>
              <span className={`status-label status-${entry.transaction.status.toLowerCase()}`}>
                {entry.transaction.status}
              </span>
            </article>
          );
        })}
        {view === 'transactions' && nextEntryCursor && (
          <button className="quiet-button" type="button" disabled={loadingMoreEntries || refreshing} onClick={() => void loadMoreEntries()}>
            {loadingMoreEntries ? 'Loading more…' : 'Load more transactions'}
          </button>
        )}
      </section>
      <section className="customer-payment-attempts" aria-label="Payment attempts">
        <h2>Payment attempts</h2>
        {loading ? <p>Loading payment attempts…</p> : payments.length === 0 ? (
          <p>No payment attempts have been recorded.</p>
        ) : payments.map((payment) => (
          <article key={payment.internalReference}>
            <div><b>{payment.type.replaceAll('_', ' ')}</b><small>Ref {payment.internalReference.slice(-8)} · {new Date(payment.createdAt).toLocaleDateString(PLATFORM_CURRENCY.locale)}</small></div>
            <strong>{formatMoney(payment.amountKes)}</strong>
            <span className={`status-label status-${payment.status.toLowerCase()}`}>{payment.status}</span>
            <details className="transaction-details">
              <summary>Details</summary>
              <dl>
                <div><dt>Full reference</dt><dd>{payment.internalReference}</dd></div>
                <div><dt>Provider status</dt><dd>{payment.providerResult.message}</dd></div>
                {payment.receiptReference && <div><dt>Verified receipt</dt><dd>{payment.receiptReference}</dd></div>}
                <div><dt>Created</dt><dd>{new Date(payment.createdAt).toLocaleString(PLATFORM_CURRENCY.locale)}</dd></div>
              </dl>
            </details>
          </article>
        ))}
      </section>
      {view === 'wallet' && <Link className="legal-home" href="/transactions">View all transactions ↗</Link>}
    </main>
  );
}