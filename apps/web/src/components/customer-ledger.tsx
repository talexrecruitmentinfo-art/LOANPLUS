'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { apiRequest } from '@/lib/api';
import { formatMoney, PLATFORM_CURRENCY } from '@/lib/currency';

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

export default function CustomerLedger({ view }: { view: 'wallet' | 'transactions' }) {
  const router = useRouter();
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [nextEntryCursor, setNextEntryCursor] = useState<string | null>(null);
  const [loadingMoreEntries, setLoadingMoreEntries] = useState(false);
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [depositQuote, setDepositQuote] = useState<WalletDepositQuote | null>(null);
  const [eligibleLoans, setEligibleLoans] = useState<EligibleLoan[] | null>(null);
  const [repaymentReadiness, setRepaymentReadiness] = useState<WalletRepaymentReadiness | null>(null);
  const [serviceErrors, setServiceErrors] = useState<string[]>([]);
  const [depositAmount, setDepositAmount] = useState('');
  const [mpesaPhoneNumber, setMpesaPhoneNumber] = useState('');
  const [selectedLoanId, setSelectedLoanId] = useState('');
  const [repaymentAmount, setRepaymentAmount] = useState('');
  const [walletActionBusy, setWalletActionBusy] = useState(false);
  const [walletActionMessage, setWalletActionMessage] = useState('');
  const [walletActionError, setWalletActionError] = useState('');
  const [walletStatusVerified, setWalletStatusVerified] = useState(false);
  const refreshSequence = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++refreshSequence.current;
    setRefreshing(true);
    setLoadingMoreEntries(false);
    if (view === 'wallet') setWalletStatusVerified(false);
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
      if (view === 'wallet') {
        const [quoteResult, loansResult, readinessResult] = await Promise.allSettled([
          apiRequest<WalletDepositQuote>('/payments/wallet-deposit-quote', { cache: 'no-store' }),
          apiRequest<EligibleLoan[]>('/loans/repayments/eligible', { cache: 'no-store' }),
          apiRequest<WalletRepaymentReadiness>('/loans/repayments/readiness', { cache: 'no-store' }),
        ]);
        if (requestId !== refreshSequence.current) return;
        const errors: string[] = [];
        if (quoteResult.status === 'fulfilled') setDepositQuote(quoteResult.value);
        else {
          setDepositQuote(null);
          errors.push(quoteResult.reason instanceof Error ? quoteResult.reason.message : 'Deposit availability could not be checked.');
        }
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
        setWalletStatusVerified(quoteResult.status === 'fulfilled');
        if (loansResult.status === 'fulfilled' && !loansResult.value.some((loan) => loan.id === selectedLoanId)) {
          const nextLoan = loansResult.value[0];
          setSelectedLoanId(nextLoan?.id ?? '');
          setRepaymentAmount(nextLoan ? String(nextLoan.amountDueKes) : '');
        }
      }
    } catch (reason) {
      if (requestId !== refreshSequence.current) return;
      if (reason instanceof Error && reason.message.includes('Authentication required')) {
        router.replace('/login');
      }
      setError(reason instanceof Error ? reason.message : 'Account activity could not be loaded.');
    } finally {
      if (requestId === refreshSequence.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [router, selectedLoanId, view]);

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
  const unresolvedDeposit = payments.some((payment) =>
    payment.type === 'WALLET_DEPOSIT' && (payment.status === 'PENDING' || payment.unresolved));

  useEffect(() => {
    if (view !== 'wallet' || !unresolvedDeposit) return;
    const interval = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(interval);
  }, [refresh, unresolvedDeposit, view]);

  async function submitDeposit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amountKes = Number(depositAmount);
    if (!Number.isSafeInteger(amountKes) || amountKes <= 0 || !depositQuote?.depositAvailable) return;
    if (!window.confirm(`Confirm an M-Pesa wallet deposit of ${formatMoney(amountKes)}?`)) return;
    setWalletActionBusy(true);
    setWalletActionError('');
    setWalletActionMessage('');
    try {
      const result = await apiRequest<{ reference: string; status: string; message: string }>('/payments/wallet-deposits', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ amountKes, mpesaPhoneNumber }),
      });
      setWalletActionMessage(`${result.message} Reference: ${result.reference} · ${result.status}.`);
      await refresh();
    } catch (reason) {
      setWalletActionError(reason instanceof Error ? reason.message : 'The wallet deposit could not be started.');
    } finally {
      setWalletActionBusy(false);
    }
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
        <h2>Deposit with M-Pesa</h2>
        {unresolvedDeposit && <p className="form-error" role="alert">A previous wallet deposit is unresolved. Refresh its status and wait for reconciliation before starting another deposit.</p>}
        {depositQuote?.unavailableReasons.map((reason) => <p className="form-error" role="status" key={reason}>{reason}</p>)}
        {serviceErrors.map((reason) => <p className="form-error" role="alert" key={reason}>{reason}</p>)}
        <form className="wallet-action-form" onSubmit={submitDeposit}>
          <label>Deposit amount (KES)
            <input type="number" min={depositQuote?.minimumAmountKes ?? undefined} max={depositQuote?.maximumAmountKes ?? undefined} step="1" value={depositAmount} onChange={(event) => setDepositAmount(event.target.value)} required />
          </label>
          {depositQuote && <small>
            {depositQuote.minimumAmountKes !== null && depositQuote.maximumAmountKes !== null
              ? `Allowed amount: ${formatMoney(depositQuote.minimumAmountKes)}–${formatMoney(depositQuote.maximumAmountKes)}.`
              : 'Deposit limits are not configured.'}
          </small>}
          <label>M-Pesa phone number
            <input type="tel" inputMode="tel" autoComplete="tel" value={mpesaPhoneNumber} onChange={(event) => setMpesaPhoneNumber(event.target.value)} placeholder="+2547…" required />
          </label>
          <button className="button" type="submit" disabled={walletActionBusy || loading || !walletStatusVerified || unresolvedDeposit || !depositQuote?.depositAvailable}>
            {walletActionBusy ? 'Starting…' : 'Continue to M-Pesa'}
          </button>
        </form>
        <p>Your balance is credited only after verified M-Pesa confirmation. If a request is unresolved, do not submit another deposit.</p>
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
            <button className="button" type="submit" disabled={walletActionBusy || loading || !walletStatusVerified || eligibleLoans === null || !repaymentReadiness?.repaymentAvailable || !wallet || Number(repaymentAmount) > wallet.balanceKes}>
              {walletActionBusy ? 'Processing…' : 'Review and repay'}
            </button>
          </form>
        )}
        {walletActionMessage && <p className="wallet-action-success" role="status">{walletActionMessage}</p>}
        {walletActionError && <p className="form-error" role="alert">{walletActionError}</p>}
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