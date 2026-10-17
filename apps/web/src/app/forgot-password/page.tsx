'use client';

import { useState, type FormEvent } from 'react';
import { AuthShell } from '@/components/auth-shell';
import { apiRequest } from '@/lib/api';

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      await apiRequest('/auth/password/reset/request', { method: 'POST', body: JSON.stringify(values) });
      setSent(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The request could not be completed.');
    } finally {
      setBusy(false);
    }
  }

  return <AuthShell eyebrow="ACCOUNT RECOVERY" title="Reset your password." description="Enter your account email. If it matches an eligible account, we will send a one-time reset link.">
    {sent ? <p className="form-success" role="status">If an eligible account exists, password reset instructions will be sent.</p> : <form className="auth-form" onSubmit={submit}><label>Email address<input name="email" type="email" autoComplete="email" maxLength={254} required /></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="button auth-submit" disabled={busy}>{busy ? 'Submitting…' : 'Send reset link'} <span aria-hidden="true">↗</span></button></form>}
  </AuthShell>;
}