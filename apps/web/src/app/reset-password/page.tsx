'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { AuthShell } from '@/components/auth-shell';
import { apiRequest } from '@/lib/api';

export default function ResetPasswordPage() {
  const router = useRouter();
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => setToken(new URLSearchParams(window.location.search).get('token') ?? ''), []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      await apiRequest('/auth/password/reset/complete', { method: 'POST', body: JSON.stringify({ ...values, token }) });
      router.push('/login?reset=complete');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The reset link could not be used.');
    } finally {
      setBusy(false);
    }
  }

  return <AuthShell eyebrow="ACCOUNT RECOVERY" title="Choose a new password." description="Reset links expire and can only be used once.">
    {!token ? <p className="form-error" role="alert">This reset link is missing or invalid. Request a new one.</p> : <form className="auth-form" onSubmit={submit}><label>New password<input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={72} required /></label><label>Confirm password<input name="confirmPassword" type="password" autoComplete="new-password" minLength={12} maxLength={72} required /></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="button auth-submit" disabled={busy}>{busy ? 'Updating…' : 'Update password'} <span aria-hidden="true">↗</span></button></form>}
  </AuthShell>;
}