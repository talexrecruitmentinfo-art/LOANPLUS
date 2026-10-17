'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { AuthShell } from '@/components/auth-shell';
import { apiRequest } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      await apiRequest('/auth/login', { method: 'POST', body: JSON.stringify(values) });
      router.push('/dashboard');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Login could not be completed.');
    } finally {
      setBusy(false);
    }
  }

  return <AuthShell eyebrow="CUSTOMER SIGN IN" title="Welcome back." description="Sign in with the email address and password you used to register.">
    <form className="auth-form" onSubmit={submit}>
      <label>Email address<input name="email" type="email" autoComplete="email" maxLength={254} required /></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" maxLength={72} required /></label>
      <div className="form-inline"><span>Protected customer sign-in</span><a href="/forgot-password">Forgot password?</a></div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="button auth-submit" disabled={busy}>{busy ? 'Signing in…' : 'Log in'} <span aria-hidden="true">↗</span></button>
      <p className="auth-switch">New to LoanPlus? <a href="/register">Create an account</a></p>
    </form>
  </AuthShell>;
}