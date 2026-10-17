'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { AuthShell } from '@/components/auth-shell';
import { apiRequest } from '@/lib/api';

interface Challenge { challengeId: string; expiresInSeconds: number }

export default function AdminLoginPage() {
  const router = useRouter();
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      if (!challenge) {
        setChallenge(await apiRequest<Challenge>('/admin/auth/password', { method: 'POST', body: JSON.stringify(values) }));
      } else {
        await apiRequest('/admin/auth/otp', { method: 'POST', body: JSON.stringify({ challengeId: challenge.challengeId, code: values.code }) });
        router.push('/admin');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Administrator verification could not be completed.');
    } finally {
      setBusy(false);
    }
  }

  return <AuthShell eyebrow="RESTRICTED ACCESS" title={challenge ? 'Check your inbox.' : 'Administrator sign in.'} description={challenge ? `Enter the six-digit code sent to the configured administrator email. It expires in ${challenge.expiresInSeconds} seconds.` : 'Password verification is followed by a fresh email code for every sign-in.'}>
    <form className="auth-form" onSubmit={submit}>
      {!challenge ? <><label>Administrator email<input name="email" type="email" autoComplete="username" maxLength={254} required /></label><label>Password<input name="password" type="password" autoComplete="current-password" maxLength={72} required /></label></> : <label>Six-digit email code<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required autoFocus /></label>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="button auth-submit" disabled={busy}>{busy ? 'Verifying…' : challenge ? 'Verify code' : 'Continue'} <span aria-hidden="true">↗</span></button>
      {challenge && <button className="text-button" type="button" onClick={() => setChallenge(null)}>Start over</button>}
    </form>
  </AuthShell>;
}