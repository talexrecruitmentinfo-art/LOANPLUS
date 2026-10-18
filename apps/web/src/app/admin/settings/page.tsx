'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiRequest } from '@/lib/api';
import PlatformSettingsPanel from '@/components/platform-settings-panel';

interface LedgerAccount {
  id: string;
  code: string;
  name: string;
  accountType: string;
  currency: string;
  isActive: boolean;
}

interface ProcessingFeeSettings {
  revenueAccountCode: string | null;
  amountKes: number;
  currency: string;
}

export default function AdminSettingsPage() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<LedgerAccount[]>([]);
  const [processingFee, setProcessingFee] = useState<ProcessingFeeSettings | null>(null);
  const [revenueAccountCode, setRevenueAccountCode] = useState('');
  const [newAccountCode, setNewAccountCode] = useState('');
  const [newAccountName, setNewAccountName] = useState('');
  const [newAccountType, setNewAccountType] = useState('ASSET');
  const [accountReason, setAccountReason] = useState('');
  const [configurationReason, setConfigurationReason] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const [settings, nextAccounts] = await Promise.all([
      apiRequest<ProcessingFeeSettings>('/admin/loans/processing-fee-settings'),
      apiRequest<LedgerAccount[]>('/admin/ledger/accounts'),
    ]);
    setProcessingFee(settings);
    setRevenueAccountCode(settings.revenueAccountCode ?? '');
    setAccounts(nextAccounts);
  }

  useEffect(() => { refresh().catch(() => router.replace('/admin/login')); }, [router]);

  async function createAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiRequest('/admin/ledger/accounts', {
        method: 'POST',
        body: JSON.stringify({
          code: newAccountCode.toUpperCase(),
          name: newAccountName,
          accountType: newAccountType,
          reason: accountReason,
        }),
      });
      setNewAccountCode('');
      setNewAccountName('');
      setAccountReason('');
      await refresh();
      setNotice('Ledger account created and audited.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The account could not be created.');
    } finally {
      setBusy(false);
    }
  }

  async function saveProcessingFeeAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const updated = await apiRequest<ProcessingFeeSettings>('/admin/loans/processing-fee-settings', {
        method: 'PATCH',
        body: JSON.stringify({ revenueAccountCode, reason: configurationReason }),
      });
      setProcessingFee(updated);
      setConfigurationReason('');
      setNotice('Loan processing-fee revenue account saved and audited.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Processing-fee accounting could not be configured.');
    } finally {
      setBusy(false);
    }
  }

  const revenueAccounts = accounts.filter((account) =>
    account.isActive && account.currency === 'KES' && account.accountType === 'REVENUE');
  const clearingReady = accounts.some((account) =>
    account.code === 'MPESA_CLEARING' && account.isActive && account.currency === 'KES' && account.accountType === 'ASSET');

  return (
    <main className="dashboard-page">
      <header className="dashboard-top">
        <Link className="wordmark" href="/admin"><span className="brand-mark">L+</span> loanplus <span className="admin-tag">ADMIN</span></Link>
        <Link className="quiet-button" href="/admin">Administration</Link>
      </header>
      <section className="dashboard-welcome">
        <p className="eyebrow">SYSTEM CONFIGURATION</p>
        <h1>Settings &amp; policy.</h1>
        <p>Customer accounts do not require an activation fee. Configure the KSh 50 loan processing-fee accounting destination before enabling fee payments.</p>
      </section>
      {error && <p className="admin-inline-error" role="alert">{error}</p>}
      {notice && <p className="admin-inline-notice" role="status">{notice}</p>}
      <section className="admin-workspace">
        <div className="admin-workspace-heading">
          <div><p className="eyebrow">CHART OF ACCOUNTS · KES</p><h2>System accounts</h2></div>
          <span>{accounts.length} accounts</span>
        </div>
        <p className="settings-copy">A verified KSh 50 processing fee posts between <code>MPESA_CLEARING</code> and a Finance-approved KES revenue account; it never credits the customer wallet.</p>
        <form className="product-config-form" onSubmit={createAccount}>
          <label>Account code<input value={newAccountCode} onChange={(event) => setNewAccountCode(event.target.value)} pattern="[A-Z][A-Z0-9_]{2,39}" placeholder="LOAN_PROCESSING_FEES" required /></label>
          <label>Account name<input value={newAccountName} onChange={(event) => setNewAccountName(event.target.value)} minLength={3} maxLength={120} required /></label>
          <label>Account type<select value={newAccountType} onChange={(event) => setNewAccountType(event.target.value)}><option value="ASSET">Asset</option><option value="LIABILITY">Liability</option><option value="REVENUE">Revenue</option><option value="EXPENSE">Expense</option><option value="EQUITY">Equity</option></select></label>
          <label>Reason<textarea value={accountReason} onChange={(event) => setAccountReason(event.target.value)} minLength={10} maxLength={500} rows={2} required /></label>
          <button className="button" disabled={busy}>Create account <span aria-hidden="true">↗</span></button>
        </form>
        <div className="admin-product-list">
          {accounts.map((account) => <article key={account.id}><div><b>{account.code} · {account.name}</b><small>{account.accountType} · {account.currency} · {account.isActive ? 'Active' : 'Inactive'}</small></div></article>)}
          {accounts.length === 0 && <p className="empty-copy">No system accounts have been configured.</p>}
        </div>
      </section>
      <section className="admin-workspace">
        <div className="admin-workspace-heading">
          <div><p className="eyebrow">LOAN PROCESSING FEE</p><h2>Payment accounting</h2></div>
          <span>{processingFee?.revenueAccountCode ? 'Configured' : 'Not configured'}</span>
        </div>
        <p className="settings-copy">Fee amount: KSh {processingFee?.amountKes ?? 50}. Payment does not guarantee approval or disbursement. Both the clearing and revenue accounts must be active and classified in KES.</p>
        {!clearingReady && <p className="form-error" role="alert">Configure an active KES asset account with code MPESA_CLEARING before processing fees can be paid.</p>}
        <form className="product-config-form" onSubmit={saveProcessingFeeAccount}>
          <label>Processing-fee revenue account<select value={revenueAccountCode} onChange={(event) => setRevenueAccountCode(event.target.value)} required>
            <option value="">Choose an active revenue account</option>
            {revenueAccounts.map((account) => <option value={account.code} key={account.id}>{account.code} · {account.name}</option>)}
          </select></label>
          <label>Configuration reason<textarea value={configurationReason} onChange={(event) => setConfigurationReason(event.target.value)} minLength={10} maxLength={500} rows={2} required /></label>
          <button className="button" disabled={busy || !clearingReady || revenueAccounts.length === 0}>Save accounting destination <span aria-hidden="true">↗</span></button>
        </form>
      </section>
      <PlatformSettingsPanel />
    </main>
  );
}
