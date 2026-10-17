'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiRequest } from '@/lib/api';

interface Referral {
  id: string;
  status: string;
  riskReview: string;
  createdAt: string;
  qualifiedAt: string | null;
  referredUser: { fullName: string; activationStatus: string };
  reward: { amountKes: number; status: string } | null;
}

interface Overview {
  referralCode: string;
  referralLink: string;
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
    if (!overview) return;
    try {
      await navigator.clipboard.writeText(overview.referralLink);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError('This browser could not copy the link. Select and copy the address shown.');
    }
  }

  if (!overview) return <main className="dashboard-loading">Loading your referral details…</main>;
  return <main className="dashboard-page"><header className="dashboard-top"><Link className="wordmark" href="/dashboard"><span className="brand-mark">L+</span> loanplus</Link><Link className="quiet-button" href="/dashboard">My account</Link></header><section className="dashboard-welcome"><p className="eyebrow">REFERRAL PROGRAMME</p><h1>Share your link.</h1><p>Referrals are tracked only after a new customer registers with your code. Any reward depends on the published programme terms and confirmed qualification.</p></section><section className="referral-content"><div className="referral-link-panel"><label htmlFor="referral-link">Your referral link</label><div><input id="referral-link" value={overview.referralLink} readOnly /><button className="button" onClick={copyLink}>{copied ? 'Copied' : 'Copy link'}</button></div><small>Code: {overview.referralCode}</small></div><div className="referral-counts"><div><span>Total registrations</span><b>{overview.total}</b></div><div><span>Qualified referrals</span><b>{overview.qualified}</b></div></div>{!overview.rewardsConfigured && <p className="referral-notice">Referral reward amounts and payout conditions are not configured. No reward is promised or credited in this build.</p>}{error && <p className="form-error" role="alert">{error}</p>}<h2>Referral activity</h2>{overview.referrals.length === 0 ? <p className="empty-copy">No referral registrations yet.</p> : <div className="referral-table">{overview.referrals.map((referral) => <article key={referral.id}><div><b>{referral.referredUser.fullName}</b><small>{new Date(referral.createdAt).toLocaleDateString('en-KE')}</small></div><span className="status-label">{referral.status.replaceAll('_', ' ')}</span><span>{referral.reward ? `Reward ${referral.reward.status.toLowerCase()}` : 'No reward recorded'}</span></article>)}</div>}</section></main>;
}