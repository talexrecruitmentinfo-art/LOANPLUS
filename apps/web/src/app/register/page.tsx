'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { AuthShell } from '@/components/auth-shell';
import { apiRequest } from '@/lib/api';

export default function RegisterPage() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [referralCode, setReferralCode] = useState('');

  useEffect(() => {
    setReferralCode(new URLSearchParams(window.location.search).get('ref')?.toUpperCase() ?? '');
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setBusy(true);
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      await apiRequest('/auth/register', { method: 'POST', body: JSON.stringify({ ...values, referralCode: referralCode || undefined, termsAccepted: values.termsAccepted === 'on', privacyAccepted: values.privacyAccepted === 'on' }) });
      router.push('/dashboard');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Registration could not be completed.');
    } finally {
      setBusy(false);
    }
  }

  return <AuthShell eyebrow="CREATE YOUR ACCOUNT" title="A good place to start." description="Enter your details to create your LoanPlus account. Identity documents are not requested.">
    <form className="auth-form" onSubmit={submit}>
      <input type="hidden" name="referralCode" value={referralCode} readOnly />
      <label>Full name<input name="fullName" autoComplete="name" maxLength={160} required /></label>
      <div className="form-row"><label>Email address<input name="email" type="email" autoComplete="email" maxLength={254} required /></label><label>Phone number<input name="phone" type="tel" autoComplete="tel" placeholder="07XX XXX XXX" required /></label></div>
      <label>National ID number<input name="nationalId" inputMode="numeric" autoComplete="off" maxLength={14} pattern="[0-9 -]{7,14}" aria-describedby="national-id-note" required /><small id="national-id-note">Enter the number only. Do not upload an ID card or document.</small></label>
      <div className="form-row"><label>Password<input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={72} required /><small>At least 12 characters.</small></label><label>Confirm password<input name="confirmPassword" type="password" autoComplete="new-password" minLength={12} maxLength={72} required /></label></div>
      <label className="check-row"><input type="checkbox" name="termsAccepted" required /><span>I accept the <a href="/terms">Terms and Conditions</a>.</span></label>
      <label className="check-row"><input type="checkbox" name="privacyAccepted" required /><span>I acknowledge the <a href="/privacy">Privacy Policy</a>.</span></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="button auth-submit" disabled={busy}>{busy ? 'Creating account…' : 'Create account'} <span aria-hidden="true">↗</span></button>
      <p className="auth-switch">Already registered? <a href="/login">Log in</a></p>
    </form>
  </AuthShell>;
}