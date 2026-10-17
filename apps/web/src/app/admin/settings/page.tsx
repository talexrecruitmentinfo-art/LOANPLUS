'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiRequest } from '@/lib/api';

interface LedgerAccount {
  id: string;
  code: string;
  name: string;
  accountType: string;
  currency: string;
  isActive: boolean;
}

interface ActivationPolicy {
  approved: boolean;
  purpose: string;
  refundability: 'REFUNDABLE' | 'NON_REFUNDABLE' | 'CONDITIONAL_REFUND';
  creditedToWallet: boolean;
  accountingTreatment: string;
  customerDisclosure: string;
  termsVersion: string;
  creditAccountCode: string | null;
}

const emptyPolicy: ActivationPolicy = {
  approved: false,
  purpose: '',
  refundability: 'CONDITIONAL_REFUND',
  creditedToWallet: false,
  accountingTreatment: '',
  customerDisclosure: '',
  termsVersion: '',
  creditAccountCode: null,
};

export default function AdminSettingsPage() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<LedgerAccount[]>([]);
  const [policy, setPolicy] = useState<ActivationPolicy>(emptyPolicy);
  const [amountKes, setAmountKes] = useState('');
  const [newAccountCode, setNewAccountCode] = useState('');
  const [newAccountName, setNewAccountName] = useState('');
  const [newAccountType, setNewAccountType] = useState('ASSET');
  const [accountReason, setAccountReason] = useState('');
  const [policyReason, setPolicyReason] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const [settings, nextAccounts] = await Promise.all([
      apiRequest<{ amountKes: number | null; policy: ActivationPolicy | null }>('/admin/settings/activation'),
      apiRequest<LedgerAccount[]>('/admin/ledger/accounts'),
    ]);
    setAmountKes(settings.amountKes?.toString() ?? '');
    setPolicy(settings.policy ?? emptyPolicy);
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
        body: JSON.stringify({ code: newAccountCode.toUpperCase(), name: newAccountName, accountType: newAccountType, reason: accountReason }),
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

  async function saveActivationPolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    const formData = new FormData(event.currentTarget);
    try {
      const updated = await apiRequest<{ policy: ActivationPolicy }>('/admin/settings/activation', {
        method: 'PATCH',
        body: JSON.stringify({
          amountKes: Number(amountKes),
          approved: formData.get('approved') === 'on',
          purpose: formData.get('purpose'),
          refundability: formData.get('refundability'),
          creditedToWallet: formData.get('creditedToWallet') === 'on',
          accountingTreatment: formData.get('accountingTreatment'),
          customerDisclosure: formData.get('customerDisclosure'),
          termsVersion: formData.get('termsVersion'),
          creditAccountCode: policy.creditedToWallet ? undefined : formData.get('creditAccountCode'),
          reason: policyReason,
        }),
      });
      setPolicy(updated.policy);
      setPolicyReason('');
      setNotice(updated.policy.approved ? 'Activation policy saved as approved.' : 'Activation policy saved but not approved for payments.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The activation policy could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  return <main className="dashboard-page"><header className="dashboard-top"><Link className="wordmark" href="/admin"><span className="brand-mark">L+</span> loanplus <span className="admin-tag">ADMIN</span></Link><Link className="quiet-button" href="/admin">Administration</Link></header><section className="dashboard-welcome"><p className="eyebrow">SYSTEM CONFIGURATION</p><h1>Settings &amp; policy.</h1><p>Activation payments stay disabled until customer disclosures, ledger accounts and explicit policy approval are recorded.</p></section>{error && <p className="admin-inline-error" role="alert">{error}</p>}{notice && <p className="admin-inline-notice" role="status">{notice}</p>}<section className="admin-workspace"><div className="admin-workspace-heading"><div><p className="eyebrow">CHART OF ACCOUNTS · KES</p><h2>System accounts</h2></div><span>{accounts.length} accounts</span></div><p className="settings-copy">A clearing account with code <code>MPESA_CLEARING</code> is required for confirmed activation payments. Create a credit account only after Finance approves its classification.</p><form className="product-config-form" onSubmit={createAccount}><label>Account code<input value={newAccountCode} onChange={(event) => setNewAccountCode(event.target.value)} pattern="[A-Z][A-Z0-9_]{2,39}" placeholder="MPESA_CLEARING" required /></label><label>Account name<input value={newAccountName} onChange={(event) => setNewAccountName(event.target.value)} minLength={3} maxLength={120} required /></label><label>Account type<select value={newAccountType} onChange={(event) => setNewAccountType(event.target.value)}><option value="ASSET">Asset</option><option value="LIABILITY">Liability</option><option value="REVENUE">Revenue</option><option value="EXPENSE">Expense</option><option value="EQUITY">Equity</option></select></label><label>Reason<textarea value={accountReason} onChange={(event) => setAccountReason(event.target.value)} minLength={10} maxLength={500} rows={2} required /></label><button className="button" disabled={busy}>Create account <span aria-hidden="true">↗</span></button></form><div className="admin-product-list">{accounts.map((account) => <article key={account.id}><div><b>{account.code} · {account.name}</b><small>{account.accountType} · {account.currency} · {account.isActive ? 'Active' : 'Inactive'}</small></div></article>)}{accounts.length === 0 && <p className="empty-copy">No system accounts have been configured.</p>}</div></section><section className="admin-workspace"><div className="admin-workspace-heading"><div><p className="eyebrow">ACTIVATION POLICY</p><h2>Customer payment terms</h2></div><span>{policy.approved ? 'Approved' : 'Not approved'}</span></div><form className="product-config-form" onSubmit={saveActivationPolicy}><label>Activation amount (KSh)<input type="number" min="1" max="100000" step="1" value={amountKes} onChange={(event) => setAmountKes(event.target.value)} required /></label><label>Purpose<textarea name="purpose" minLength={10} maxLength={500} defaultValue={policy.purpose} required /></label><label>Refundability<select name="refundability" value={policy.refundability} onChange={(event) => setPolicy({ ...policy, refundability: event.target.value as ActivationPolicy['refundability'] })}><option value="REFUNDABLE">Refundable</option><option value="NON_REFUNDABLE">Non-refundable</option><option value="CONDITIONAL_REFUND">Conditional refund</option></select></label><label className="check-row"><input type="checkbox" name="creditedToWallet" checked={policy.creditedToWallet} onChange={(event) => setPolicy({ ...policy, creditedToWallet: event.target.checked })} /><span>Credit the confirmed amount to the customer wallet</span></label>{!policy.creditedToWallet && <label>Accounting credit account<select name="creditAccountCode" value={policy.creditAccountCode ?? ''} onChange={(event) => setPolicy({ ...policy, creditAccountCode: event.target.value })} required><option value="">Choose an account</option>{accounts.map((account) => <option value={account.code} key={account.id}>{account.code} · {account.name} ({account.accountType})</option>)}</select></label>}<label>Accounting treatment<textarea name="accountingTreatment" minLength={10} maxLength={500} defaultValue={policy.accountingTreatment} required /></label><label>Customer disclosure<textarea name="customerDisclosure" minLength={20} maxLength={2000} rows={4} defaultValue={policy.customerDisclosure} required /></label><label>Terms version<input name="termsVersion" minLength={1} maxLength={40} defaultValue={policy.termsVersion} required /></label><label className="check-row"><input type="checkbox" name="approved" defaultChecked={policy.approved} /><span>Approve this activation policy for payment processing</span></label><label>Change reason<textarea value={policyReason} onChange={(event) => setPolicyReason(event.target.value)} minLength={10} maxLength={500} rows={2} required /></label><button className="button" disabled={busy}>Save activation policy <span aria-hidden="true">↗</span></button></form></section></main>;
}