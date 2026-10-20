'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { apiRequest } from '@/lib/api';
import { formatMoney } from '@/lib/currency';

interface LedgerAccount {
  id: string;
  code: string;
  name: string;
  accountType: string;
  currency: string;
  isActive: boolean;
}

interface WalletDepositHistoryItem {
  id: string;
  actorId: string | null;
  actorEmail: string | null;
  createdAt: string;
  reason: string | null;
  changedFields: string[];
  before: unknown;
  after: unknown;
}

interface WalletDepositConfiguration {
  minimumAmountKes: number | null;
  maximumAmountKes: number | null;
  productApproved: boolean;
  approvalReference: string | null;
  approvalEvidence: string | null;
  customerWalletLiabilityAccountCode: string;
  mpesaClearingAccountCode: string;
  configurationReason: string | null;
  updatedAt: string | null;
  updatedById: string | null;
  updatedByEmail: string | null;
  ready: boolean;
  unavailableReasons: string[];
  history: WalletDepositHistoryItem[];
}

interface DepositQuote {
  depositAvailable: boolean;
  unavailableReasons: string[];
}

const WALLET_LIABILITY_CODE = 'CUSTOMER_WALLET_LIABILITY';
const MPESA_CLEARING_CODE = 'MPESA_CLEARING';

function printable(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export default function WalletDepositSettings() {
  const [configuration, setConfiguration] = useState<WalletDepositConfiguration | null>(null);
  const [accounts, setAccounts] = useState<LedgerAccount[]>([]);
  const [quote, setQuote] = useState<DepositQuote | null>(null);
  const [minimum, setMinimum] = useState('');
  const [maximum, setMaximum] = useState('');
  const [productApproved, setProductApproved] = useState(false);
  const [approvalReference, setApprovalReference] = useState('');
  const [approvalEvidence, setApprovalEvidence] = useState('');
  const [walletLiabilityCode, setWalletLiabilityCode] = useState(WALLET_LIABILITY_CODE);
  const [clearingCode, setClearingCode] = useState(MPESA_CLEARING_CODE);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setError('');
    const [nextConfiguration, nextAccounts, nextQuote] = await Promise.all([
      apiRequest<WalletDepositConfiguration>('/admin/settings/platform/wallet-deposits', { cache: 'no-store' }),
      apiRequest<LedgerAccount[]>('/admin/ledger/accounts', { cache: 'no-store' }),
      apiRequest<DepositQuote>('/payments/wallet-deposit-quote', { cache: 'no-store' }),
    ]);
    setConfiguration(nextConfiguration);
    setAccounts(nextAccounts);
    setQuote(nextQuote);
    setMinimum(nextConfiguration.minimumAmountKes?.toString() ?? '');
    setMaximum(nextConfiguration.maximumAmountKes?.toString() ?? '');
    setProductApproved(nextConfiguration.productApproved);
    setApprovalReference(nextConfiguration.approvalReference ?? '');
    setApprovalEvidence(nextConfiguration.approvalEvidence ?? '');
    setWalletLiabilityCode(nextConfiguration.customerWalletLiabilityAccountCode);
    setClearingCode(nextConfiguration.mpesaClearingAccountCode);
  }

  useEffect(() => { void refresh().catch((cause) => {
    setError(cause instanceof Error ? cause.message : 'Wallet deposit settings could not be loaded.');
  }); }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setNotice('');
    const minimumAmountKes = Number(minimum);
    const maximumAmountKes = Number(maximum);
    if (!Number.isSafeInteger(minimumAmountKes) || !Number.isSafeInteger(maximumAmountKes) ||
      minimumAmountKes < 1 || maximumAmountKes < minimumAmountKes || maximumAmountKes > 2_147_483_647) {
      setError('Enter positive whole-KSh limits, with the minimum no greater than the maximum.');
      return;
    }
    if (productApproved && !approvalReference.trim()) {
      setError('Enter the verified Safaricom production approval reference before enabling wallet deposits.');
      return;
    }
    setBusy(true);
    try {
      const updated = await apiRequest<WalletDepositConfiguration>('/admin/settings/platform/wallet-deposits', {
        method: 'PATCH',
        body: JSON.stringify({
          minimumAmountKes,
          maximumAmountKes,
          productApproved,
          approvalReference,
          approvalEvidence,
          customerWalletLiabilityAccountCode: walletLiabilityCode,
          mpesaClearingAccountCode: clearingCode,
          reason,
        }),
      });
      setConfiguration(updated);
      setReason('');
      setNotice('Wallet deposit configuration saved and audited.');
      const latestQuote = await apiRequest<DepositQuote>('/payments/wallet-deposit-quote', { cache: 'no-store' });
      setQuote(latestQuote);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Wallet deposit configuration could not be saved.');
      await refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  const walletLiability = accounts.find((account) => account.code === WALLET_LIABILITY_CODE);
  const mpesaClearing = accounts.find((account) => account.code === MPESA_CLEARING_CODE);
  const walletAccountReady = !!walletLiability?.isActive && walletLiability.currency === 'KES' &&
    walletLiability.accountType === 'LIABILITY';
  const clearingAccountReady = !!mpesaClearing?.isActive && mpesaClearing.currency === 'KES' &&
    mpesaClearing.accountType === 'ASSET';

  return (
    <section className="admin-workspace">
      <div className="admin-workspace-heading">
        <div><p className="eyebrow">WALLET DEPOSITS · KES</p><h2>Wallet Deposits</h2></div>
        <span>{quote?.depositAvailable ? 'Customer deposits available' : 'Customer deposits unavailable'}</span>
      </div>
      <p className="settings-copy">
        Limits and external production-product eligibility are persisted configuration. Saving this form alone does not
        establish Safaricom approval or payment readiness.
      </p>
      {error && <p className="admin-inline-error" role="alert">{error}</p>}
      {notice && <p className="admin-inline-notice" role="status">{notice}</p>}
      {quote?.unavailableReasons.map((message) =>
        <p className="form-error" role="status" key={message}>{message}</p>)}
      {configuration && (
        <form className="product-config-form" onSubmit={(event) => void save(event)}>
          <label>Minimum deposit amount (KES)
            <input type="number" min="1" max="2147483647" step="1" value={minimum}
              onChange={(event) => setMinimum(event.target.value)} required />
          </label>
          <label>Maximum deposit amount (KES)
            <input type="number" min="1" max="2147483647" step="1" value={maximum}
              onChange={(event) => setMaximum(event.target.value)} required />
          </label>
          <p className="settings-copy">Enter approved business-policy limits; no example limits are pre-filled.</p>
          <label className="check-row">
            <input type="checkbox" checked={productApproved}
              onChange={(event) => setProductApproved(event.target.checked)} />
            <span>I verified Safaricom production approval specifically for customer wallet deposits.</span>
          </label>
          <label>Verified approval reference
            <input value={approvalReference} onChange={(event) => setApprovalReference(event.target.value)}
              maxLength={120} required={productApproved} />
          </label>
          <label>Approval evidence notes (no credentials or secrets)
            <textarea value={approvalEvidence} onChange={(event) => setApprovalEvidence(event.target.value)}
              maxLength={500} rows={2} />
          </label>
          <label>Customer wallet liability account
            <select value={walletLiabilityCode} onChange={(event) => setWalletLiabilityCode(event.target.value)} required>
              <option value={WALLET_LIABILITY_CODE} disabled={!walletAccountReady}>
                {walletLiability ? `${walletLiability.code} · ${walletLiability.name}` : WALLET_LIABILITY_CODE}
              </option>
            </select>
          </label>
          <small>{walletAccountReady ? 'Active KES liability account verified.' : 'Required account must be active and classified as a KES liability.'}</small>
          <label>M-Pesa clearing account
            <select value={clearingCode} onChange={(event) => setClearingCode(event.target.value)} required>
              <option value={MPESA_CLEARING_CODE} disabled={!clearingAccountReady}>
                {mpesaClearing ? `${mpesaClearing.code} · ${mpesaClearing.name}` : MPESA_CLEARING_CODE}
              </option>
            </select>
          </label>
          <small>{clearingAccountReady ? 'Active KES asset account verified.' : 'Required account must be active and classified as a KES asset.'}</small>
          <label>Configuration reason
            <textarea value={reason} onChange={(event) => setReason(event.target.value)}
              minLength={10} maxLength={500} rows={2} required />
          </label>
          <button className="button" disabled={busy || !walletAccountReady || !clearingAccountReady}>
            {busy ? 'Saving…' : 'Save wallet deposit configuration'}
          </button>
          <small>
            Saved limits: {configuration.minimumAmountKes === null || configuration.maximumAmountKes === null
              ? 'Not configured'
              : `${formatMoney(configuration.minimumAmountKes)}–${formatMoney(configuration.maximumAmountKes)}`}
            {' · '}Product approval: {configuration.productApproved ? 'Verified reference recorded' : 'Not approved'}
          </small>
          {configuration.updatedAt && <small>
            Last changed {new Date(configuration.updatedAt).toLocaleString('en-KE')} · administrator
            {' '}{configuration.updatedByEmail ?? configuration.updatedById}
          </small>}
        </form>
      )}
      {configuration && (
        <div className="admin-product-list" aria-label="Wallet deposit configuration audit history">
          <h3>Configuration audit history</h3>
          {configuration.history.map((event) => (
            <article key={event.id}>
              <div>
                <b>{new Date(event.createdAt).toLocaleString('en-KE')} · {event.actorEmail ?? event.actorId ?? 'Administrator'}</b>
                <small>{event.reason ?? 'No reason recorded'} · Changed: {event.changedFields.join(', ') || 'No fields changed'}</small>
                <details className="transaction-details">
                  <summary>View old and new values</summary>
                  <dl>
                    <div><dt>Before</dt><dd><pre>{printable(event.before)}</pre></dd></div>
                    <div><dt>After</dt><dd><pre>{printable(event.after)}</pre></dd></div>
                  </dl>
                </details>
              </div>
            </article>
          ))}
          {configuration.history.length === 0 && <p className="empty-copy">No wallet-deposit configuration changes recorded.</p>}
        </div>
      )}
    </section>
  );
}
