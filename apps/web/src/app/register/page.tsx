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
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

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
      <div className="form-row"><label>Email address<input name="email" type="email" autoComplete="email" maxLength={254} required /></label><label>Phone number<input name="phone" type="tel" autoComplete="tel" placeholder="07XX XXX XXX" maxLength={19} pattern="(?:(?=(?:[^0-9]*[0-9]){10}[^0-9]*$)\x2B?[ \x28\x29\x2D]*0[ \x28\x29\x2D]*[17][0-9 \x28\x29\x2D]{8,16}|(?=(?:[^0-9]*[0-9]){12}[^0-9]*$)\x2B?[ \x28\x29\x2D]*2[ \x28\x29\x2D]*5[ \x28\x29\x2D]*4[ \x28\x29\x2D]*[17][0-9 \x28\x29\x2D]{8,16})" title="Use a Kenyan number such as 0712345678 or +254712345678." required /></label></div>
      <label>National ID number<input name="nationalId" inputMode="numeric" autoComplete="off" maxLength={14} pattern="(?:[0-9](?:[ \x2D]*[0-9]){6}|[0-9](?:[ \x2D]*[0-9]){7})" aria-describedby="national-id-note" required /><small id="national-id-note">Enter 7 or 8 digits, optionally separated by spaces or hyphens. Do not upload an ID card or document.</small></label>
      <div className="form-row"><label>Password<div className="password-input-wrap"><input name="password" type={showPassword ? 'text' : 'password'} autoComplete="new-password" minLength={12} maxLength={72} required /><button type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword((shown) => !shown)}>{showPassword ? 'Hide' : 'Show'}</button></div><small>At least 12 characters.</small></label><label>Confirm password<div className="password-input-wrap"><input name="confirmPassword" type={showConfirmPassword ? 'text' : 'password'} autoComplete="new-password" minLength={12} maxLength={72} required /><button type="button" aria-label={showConfirmPassword ? 'Hide confirmation' : 'Show confirmation'} onClick={() => setShowConfirmPassword((shown) => !shown)}>{showConfirmPassword ? 'Hide' : 'Show'}</button></div></label></div>
      <label className="check-row"><input type="checkbox" name="termsAccepted" required /><span>I accept the <a href="/terms">Terms and Conditions</a>.</span></label>
      <label className="check-row"><input type="checkbox" name="privacyAccepted" required /><span>I acknowledge the <a href="/privacy">Privacy Policy</a>.</span></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="button auth-submit" disabled={busy}>{busy ? 'Creating account…' : 'Create account'} <span aria-hidden="true">↗</span></button>
      <p className="auth-switch">Already registered? <a href="/login">Log in</a></p>
    </form>
  </AuthShell>;
}