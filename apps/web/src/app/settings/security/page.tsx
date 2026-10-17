'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiRequest } from '@/lib/api';

export default function SecuritySettingsPage() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { apiRequest('/auth/me').catch(() => router.replace('/login')); }, [router]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    setError('');
    const values = Object.fromEntries(new FormData(form).entries());
    try {
      await apiRequest('/auth/password/change', { method: 'POST', body: JSON.stringify(values) });
      router.replace('/login?password=changed');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Password could not be changed.');
      setBusy(false);
    }
  }

  return <main className="dashboard-page"><header className="dashboard-top"><Link className="wordmark" href="/dashboard"><span className="brand-mark">L+</span> loanplus</Link><Link className="quiet-button" href="/dashboard">My account</Link></header><section className="dashboard-welcome"><p className="eyebrow">ACCOUNT SECURITY</p><h1>Change password.</h1><p>Changing your password revokes all active customer sessions. Sign in again with your new password.</p></section><section className="support-content"><form className="support-form" onSubmit={submit}><label>Current password<input name="currentPassword" type="password" autoComplete="current-password" required /></label><label>New password<input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={72} required /><small>Use at least 12 characters.</small></label><label>Confirm new password<input name="confirmPassword" type="password" autoComplete="new-password" minLength={12} maxLength={72} required /></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="button" disabled={busy}>{busy ? 'Updating…' : 'Change password'} <span aria-hidden="true">↗</span></button></form></section></main>;
}