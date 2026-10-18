'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiRequest } from '@/lib/api';
import { formatMoney, PLATFORM_CURRENCY } from '@/lib/currency';

interface Wallet {
  balanceKes: number;
  currency: string;
}

interface LedgerEntry {
  id: string;
  debitKes: number;
  creditKes: number;
  createdAt: string;
  account: { code: string; name: string };
  transaction: { internalReference: string; transactionType: string; status: string };
}

interface PaymentRecord {
  internalReference: string;
  type: string;
  amountKes: number;
  currency: string;
  status: string;
  receiptReference: string | null;
  createdAt: string;
  providerResult: { code: number | null; message: string };
}

export default function CustomerLedger({ view }: { view: 'wallet' | 'transactions' }) {
  const router = useRouter();
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError('');
    try {
      const [nextWallet, nextEntries, nextPayments] = await Promise.all([
        apiRequest<Wallet>('/wallet', { cache: 'no-store' }),
        apiRequest<LedgerEntry[]>('/wallet/transactions', { cache: 'no-store' }),
        apiRequest<PaymentRecord[]>('/payments', { cache: 'no-store' }),
      ]);
      if (nextWallet.currency !== PLATFORM_CURRENCY.code) {
        throw new Error('The wallet currency does not match the supported platform currency.');
      }
      setWallet(nextWallet);
      setEntries(nextEntries);
      setPayments(nextPayments);
    } catch (reason) {
      if (reason instanceof Error && reason.message.includes('Authentication required')) {
        router.replace('/login');
      }
      setError(reason instanceof Error ? reason.message : 'Account activity could not be loaded.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [router]);

  useEffect(() => { void refresh(); }, [refresh]);

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
          <small>Available in {PLATFORM_CURRENCY.name} · {PLATFORM_CURRENCY.code}</small>
        </section>
      )}
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
                <small>{entry.transaction.internalReference} · {new Date(entry.createdAt).toLocaleString(PLATFORM_CURRENCY.locale)}</small>
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
      </section>
      <section className="customer-payment-attempts" aria-label="Payment attempts">
        <h2>Payment attempts</h2>
        {loading ? <p>Loading payment attempts…</p> : payments.length === 0 ? (
          <p>No payment attempts have been recorded.</p>
        ) : payments.map((payment) => (
          <article key={payment.internalReference}>
            <div><b>{payment.type.replaceAll('_', ' ')}</b><small>{payment.internalReference} · {new Date(payment.createdAt).toLocaleString(PLATFORM_CURRENCY.locale)}</small></div>
            <strong>{formatMoney(payment.amountKes)}</strong>
            <span className={`status-label status-${payment.status.toLowerCase()}`}>{payment.status}</span>
            <p>{payment.providerResult.message}</p>
            {payment.receiptReference && <small>Verified receipt {payment.receiptReference}</small>}
          </article>
        ))}
      </section>
      {view === 'wallet' && <Link className="legal-home" href="/transactions">View all transactions ↗</Link>}
    </main>
  );
}