'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiRequest } from '@/lib/api';
import { formatMoney } from '@/lib/currency';

interface TrustProfile {
  identityStatus: string;
}

interface ProcessingFeeQuote {
  amountKes: number;
  currency: string;
  refundPolicyStatus: string;
  refundPolicyVersion: string | null;
  refundPolicyDisclosure: string | null;
}

export default function TrustCentrePage() {
  const router = useRouter();
  const [profile, setProfile] = useState<TrustProfile | null>(null);
  const [fee, setFee] = useState<ProcessingFeeQuote | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    const [profileResult, feeResult] = await Promise.allSettled([
      apiRequest<TrustProfile>('/auth/me', { cache: 'no-store' }),
      apiRequest<ProcessingFeeQuote>('/payments/loan-processing-fee-quote', { cache: 'no-store' }),
    ]);
    if (profileResult.status === 'fulfilled') setProfile(profileResult.value);
    else if (profileResult.reason instanceof Error && profileResult.reason.message.includes('Authentication required')) router.replace('/login');
    else setError(profileResult.reason instanceof Error ? profileResult.reason.message : 'Account information could not be loaded.');
    if (feeResult.status === 'fulfilled') setFee(feeResult.value);
    else setError((message) => message || 'Fee information could not be loaded.');
    setLoading(false);
  }, [router]);

  useEffect(() => { void refresh(); }, [refresh]);

  return <main className="dashboard-page trust-page">
    <header className="dashboard-top"><Link className="wordmark" href="/dashboard"><span className="brand-mark">L+</span> loanplus</Link><Link className="quiet-button" href="/profile">Profile</Link></header>
    <section className="dashboard-welcome"><p className="eyebrow">ACCOUNT INFORMATION</p><h1>Trust Centre.</h1><p>Access account protection, published policies, and support from one place.</p></section>
    {error && <div className="trust-error" role="alert"><p>{error}</p><button className="quiet-button" type="button" disabled={loading} onClick={() => void refresh()}>{loading ? 'Retrying…' : 'Retry'}</button></div>}
    {loading && !profile ? <p className="trust-loading" role="status">Loading account information…</p> : <section className="trust-card-list" aria-label="Trust and account information">
      <article className="trust-card">
        <span className="trust-card-icon" aria-hidden="true">ID</span>
        <div><h2>Identity verification</h2><p>{profile ? `Current account status: ${profile.identityStatus.replaceAll('_', ' ').toLowerCase()}.` : 'Your identity status is unavailable.'} LoanPlus does not request ID-document uploads here.</p></div>
      </article>
      <Link className="trust-card trust-card-link" href="/settings/security"><span className="trust-card-icon" aria-hidden="true">S</span><span><b>Security settings</b><small>Change your password and protect account access.</small></span><span aria-hidden="true">›</span></Link>
      <Link className="trust-card trust-card-link" href="/terms"><span className="trust-card-icon" aria-hidden="true">T</span><span><b>Loan Terms and Conditions</b><small>View the current customer-facing terms draft.</small></span><span aria-hidden="true">›</span></Link>
      <article className="trust-card">
        <span className="trust-card-icon" aria-hidden="true">KSh</span>
        <div><h2>Fees and charges</h2><p>{fee?.currency === 'KES' && Number.isSafeInteger(fee.amountKes) ? `Loan processing fee: ${formatMoney(fee.amountKes)}.` : 'Loan processing-fee details are unavailable.'} This fee is separate from wallet funding and does not guarantee loan approval or disbursement.</p><small>{fee?.refundPolicyStatus === 'CONFIGURED' && fee.refundPolicyDisclosure ? `${fee.refundPolicyDisclosure} Policy version ${fee.refundPolicyVersion}.` : 'Approved refund conditions are not configured, and processing-fee payment is unavailable. Review the published terms or contact support.'}</small></div>
      </article>
      <Link className="trust-card trust-card-link" href="/privacy"><span className="trust-card-icon" aria-hidden="true">P</span><span><b>Privacy information</b><small>Read how account and application information is handled.</small></span><span aria-hidden="true">›</span></Link>
      <Link className="trust-card trust-card-link" href="/referrals"><span className="trust-card-icon" aria-hidden="true">R</span><span><b>Referral programme</b><small>See your actual referral activity and reward status.</small></span><span aria-hidden="true">›</span></Link>
      <Link className="trust-card trust-card-link" href="/support"><span className="trust-card-icon" aria-hidden="true">?</span><span><b>Help and report a concern</b><small>Contact support, including to report suspicious activity.</small></span><span aria-hidden="true">›</span></Link>
    </section>}
  </main>;
}