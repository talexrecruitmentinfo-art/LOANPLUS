'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiRequest } from '@/lib/api';

interface Referral {
  id: string;
  status: string;
  createdAt: string;
  referredUser: { fullName: string };
  reward: { status: string } | null;
}

interface Overview {
  eligible: boolean;
  referralCode: string | null;
  referralLink: string | null;
  total: number;
  qualified: number;
  referrals: Referral[];
  rewardsConfigured: boolean;
}

export default function ReferralsPage() {
  const router = useRouter();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    apiRequest<Overview>('/referrals/me').then(setOverview).catch(() => router.replace('/login'));
  }, [router]);

  async function copyLink() {
    if (!overview?.referralLink) return;
    try {
      await navigator.clipboard.writeText(overview.referralLink);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError('This browser could not copy the link. Select and copy the address shown.');
    }
  }

  if (!overview) return <main className="dashboard-loading">Loading your referral details…</main>;
  return <main className="dashboard-page"><header className="dashboard-top"><Link className="wordmark" href="/dashboard"><span className="brand-mark">L+</span> loanplus</Link><Link className="quiet-button" href="/dashboard">My account</Link></header><section className="dashboard-welcome"><p className="eyebrow">REFERRAL PROGRAMME</p><h1>Referral activity.</h1><p>Referral links are available only after your loan application has been approved. Reward eligibility and payment depend on configured programme terms.</p></section><section className="referral-content">{overview.eligible && overview.referralLink ? <div className="referral-link-panel"><label htmlFor="referral-link">Your referral link</label><div><input id="referral-link" value={overview.referralLink} readOnly /><button className="button" onClick={copyLink}>{copied ? 'Copied' : 'Copy link'}</button></div><small>Code: {overview.referralCode}</small></div> : <p className="referral-notice" role="status">Your referral link will become available after an approved loan application is recorded on your account.</p>}<div className="referral-counts"><div><span>Total registrations</span><b>{overview.total}</b></div><div><span>Qualified referrals</span><b>{overview.qualified}</b></div></div>{!overview.rewardsConfigured && <p className="referral-notice">Referral reward amounts and payout conditions are not configured. No reward is promised or credited in this build.</p>}{error && <p className="form-error" role="alert">{error}</p>}<h2>Referral activity</h2>{overview.referrals.length === 0 ? <p className="empty-copy">No referral registrations yet.</p> : <div className="referral-table">{overview.referrals.map((referral) => <article key={referral.id}><div><b>{referral.referredUser.fullName}</b><small>{new Date(referral.createdAt).toLocaleDateString('en-KE')}</small></div><span className="status-label">{referral.status.replaceAll('_', ' ')}</span><span>{referral.reward ? `Reward ${referral.reward.status.toLowerCase()}` : 'No reward recorded'}</span></article>)}</div>}</section></main>;
}