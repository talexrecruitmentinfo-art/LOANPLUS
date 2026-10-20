'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { AuthShell } from '@/components/auth-shell';
import { apiRequest } from '@/lib/api';

export default function StaffSetupPage() {
  const [token, setToken] = useState('');
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const url = new URL(window.location.href);
    setToken(url.searchParams.get('token') ?? '');
    url.searchParams.delete('token');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form).entries());
    setBusy(true);
    setError('');
    try {
      await apiRequest('/admin/staff/invitations/setup', {
        method: 'POST',
        body: JSON.stringify({ ...values, token }),
      });
      setToken('');
      setComplete(true);
      form.reset();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Staff account setup could not be completed.');
    } finally {
      setBusy(false);
    }
  }

  return <AuthShell
    eyebrow="STAFF ACCOUNT SETUP"
    title={complete ? 'Account setup complete.' : 'Choose your password.'}
    description={complete
      ? 'Your invitation has been used. Sign in with your work email and password; each sign-in requires a fresh email verification code.'
      : 'This invitation is single-use and expires after 24 hours. After setup, administrator access requires email verification at every sign-in.'}
  >
    {complete ? <Link className="button auth-submit" href="/admin/login">Continue to staff sign in ↗</Link> : (
      <form className="auth-form" onSubmit={(event) => void submit(event)}>
        <label>Password<input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={72} required /></label>
        <label>Confirm password<input name="confirmPassword" type="password" autoComplete="new-password" minLength={12} maxLength={72} required /></label>
        {!token && <p className="form-error" role="alert">This staff invitation is invalid or expired.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button auth-submit" disabled={busy || !token}>{busy ? 'Setting up…' : 'Complete account setup'}</button>
      </form>
    )}
  </AuthShell>;
}
