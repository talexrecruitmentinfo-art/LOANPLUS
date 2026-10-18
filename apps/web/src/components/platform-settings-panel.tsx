'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { apiRequest } from '@/lib/api';
import { formatMoney, PLATFORM_CURRENCY } from '@/lib/currency';

interface CurrencySettings {
  code: string;
  name: string;
  symbol: string;
  locale: string;
  decimalPlaces: number;
  transactionCurrency: string;
  supportedCurrencies: string[];
  updatedAt: string | null;
  updatedById: string | null;
  updatedByEmail: string | null;
}

interface InstallPolicy {
  enabled: boolean;
  updatedAt: string | null;
  updatedById: string | null;
  updatedByEmail: string | null;
}

interface ReconciliationThreshold {
  pendingThresholdMinutes: number;
  updatedAt: string | null;
  updatedById: string | null;
  updatedByEmail: string | null;
}

export default function PlatformSettingsPanel() {
  const [currency, setCurrency] = useState<CurrencySettings | null>(null);
  const [installPolicy, setInstallPolicy] = useState<InstallPolicy | null>(null);
  const [reconciliation, setReconciliation] = useState<ReconciliationThreshold | null>(null);
  const [currencyReason, setCurrencyReason] = useState('');
  const [installReason, setInstallReason] = useState('');
  const [reconciliationReason, setReconciliationReason] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setError('');
    try {
      const [nextCurrency, nextInstallPolicy, nextReconciliation] = await Promise.all([
        apiRequest<CurrencySettings>('/admin/settings/platform/currency', { cache: 'no-store' }),
        apiRequest<InstallPolicy>('/admin/settings/platform/pwa-installation', { cache: 'no-store' }),
        apiRequest<ReconciliationThreshold>('/admin/settings/platform/reconciliation', { cache: 'no-store' }),
      ]);
      setCurrency(nextCurrency);
      setInstallPolicy(nextInstallPolicy);
      setReconciliation(nextReconciliation);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Platform settings could not be loaded.');
      throw reason;
    }
  }

  useEffect(() => { void refresh().catch(() => undefined); }, []);

  async function saveCurrency(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const updated = await apiRequest<CurrencySettings>('/admin/settings/platform/currency', {
        method: 'PATCH',
        body: JSON.stringify({ currencyCode: PLATFORM_CURRENCY.code, reason: currencyReason }),
      });
      setCurrency(updated);
      setCurrencyReason('');
      setNotice('KES display settings confirmed and audited.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Currency settings could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  async function saveInstallPolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!installPolicy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const updated = await apiRequest<InstallPolicy>('/admin/settings/platform/pwa-installation', {
        method: 'PATCH',
        body: JSON.stringify({ enabled: installPolicy.enabled, reason: installReason }),
      });
      setInstallPolicy(updated);
      setInstallReason('');
      setNotice('PWA install-entry policy saved and audited. Existing installed apps are not removed.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Installation policy could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  async function saveReconciliationThreshold(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reconciliation) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const updated = await apiRequest<ReconciliationThreshold>('/admin/settings/platform/reconciliation', {
        method: 'PATCH',
        body: JSON.stringify({
          pendingThresholdMinutes: reconciliation.pendingThresholdMinutes,
          reason: reconciliationReason,
        }),
      });
      setReconciliation(updated);
      setReconciliationReason('');
      setNotice('Reconciliation queue threshold saved and audited.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Queue threshold could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="admin-workspace">
      <div className="admin-workspace-heading">
        <div><p className="eyebrow">PLATFORM SETTINGS</p><h2>Currency &amp; app installation</h2></div>
        <button className="quiet-button" type="button" onClick={() => void refresh().catch(() => undefined)}>Refresh</button>
      </div>
      {error && <p className="admin-inline-error" role="alert">{error}</p>}
      {notice && <p className="admin-inline-notice" role="status">{notice}</p>}
      {!currency || !installPolicy || !reconciliation ? error ? <p className="admin-inline-error" role="alert">Platform settings are unavailable. Refresh to try again.</p> : <p>Loading platform settings…</p> : (
        <div className="platform-settings-grid">
          <form className="product-config-form" onSubmit={(event) => void saveCurrency(event)}>
            <h3>Display currency</h3>
            <label>Currency<select value={currency.code} disabled>
              <option value="KES">KES · Kenyan Shilling · KSh</option>
              {['USD', 'EUR', 'GBP', 'UGX', 'TZS'].map((code) => <option key={code} value={code} disabled>{code} · Not supported by the KES ledger</option>)}
            </select></label>
            <p className="settings-copy">Transaction and ledger currency remains KES. Changing this display setting never converts or rewrites historical records.</p>
            <p className="currency-preview">Preview: <strong>{formatMoney(12345)}</strong></p>
            <small>Active: {currency.name} · {currency.locale} · {currency.decimalPlaces} decimals. Ledger currency: {currency.transactionCurrency}.</small>
            <label>Reason for confirmation<textarea value={currencyReason} onChange={(event) => setCurrencyReason(event.target.value)} minLength={10} maxLength={500} required /></label>
            <button className="button" disabled={busy}>Save KES settings</button>
            {currency.updatedAt && <small>Last changed {new Date(currency.updatedAt).toLocaleString('en-KE')} · administrator {currency.updatedByEmail ?? currency.updatedById}</small>}
          </form>
          <form className="product-config-form" onSubmit={(event) => void saveInstallPolicy(event)}>
            <h3>PWA install entry</h3>
            <label className="check-row"><input type="checkbox" checked={installPolicy.enabled} onChange={(event) => setInstallPolicy({ ...installPolicy, enabled: event.target.checked })} /><span>Show the install-app entry to eligible signed-in customers</span></label>
            <p className="settings-copy">This controls the LoanPlus install entry point only. It cannot uninstall an app already added to a device.</p>
            <label>Reason for change<textarea value={installReason} onChange={(event) => setInstallReason(event.target.value)} minLength={10} maxLength={500} required /></label>
            <button className="button" disabled={busy}>Save installation policy</button>
            {installPolicy.updatedAt && <small>Last changed {new Date(installPolicy.updatedAt).toLocaleString('en-KE')} · administrator {installPolicy.updatedByEmail ?? installPolicy.updatedById}</small>}
          </form>
          <form className="product-config-form" onSubmit={(event) => void saveReconciliationThreshold(event)}>
            <h3>Unresolved-payment queue</h3>
            <label>Pending age threshold (minutes)<input type="number" min="1" max="1440" step="1" value={reconciliation.pendingThresholdMinutes} onChange={(event) => setReconciliation({ ...reconciliation, pendingThresholdMinutes: Number(event.target.value) })} required /></label>
            <p className="settings-copy">Pending activation payments older than this threshold appear in the Superadmin reconciliation queue. Legacy 4999 records remain visible regardless of age.</p>
            <label>Reason for change<textarea value={reconciliationReason} onChange={(event) => setReconciliationReason(event.target.value)} minLength={10} maxLength={500} required /></label>
            <button className="button" disabled={busy}>Save queue threshold</button>
            {reconciliation.updatedAt && <small>Last changed {new Date(reconciliation.updatedAt).toLocaleString('en-KE')} · administrator {reconciliation.updatedByEmail ?? reconciliation.updatedById}</small>}
          </form>
        </div>
      )}
    </section>
  );
}