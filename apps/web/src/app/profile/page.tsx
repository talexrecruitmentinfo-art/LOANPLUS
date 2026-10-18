'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiRequest } from '@/lib/api';

interface CustomerProfile {
  fullName: string;
  email: string;
  phone: string;
  identityStatus: string;
  activationStatus: string;
  referralCode: string | null;
}

export default function ProfilePage() {
  const router = useRouter();
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    apiRequest<CustomerProfile>('/auth/me', { cache: 'no-store' })
      .then(setProfile)
      .catch(() => router.replace('/login'));
  }, [router]);

  async function logout() {
    try {
      await apiRequest('/auth/logout', { method: 'POST', body: '{}' });
      router.replace('/login');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Sign out could not be completed.');
    }
  }

  if (!profile) return <main className="dashboard-loading">Loading your profile…</main>;

  return (
    <main className="dashboard-page customer-profile-page">
      <header className="dashboard-top">
        <Link className="wordmark" href="/dashboard"><span className="brand-mark">L+</span> loanplus</Link>
        <button className="quiet-button" type="button" onClick={() => void logout()}>Log out</button>
      </header>
      <section className="dashboard-welcome">
        <p className="eyebrow">CUSTOMER ACCOUNT</p>
        <h1>Your profile.</h1>
        <p>Personal details shown here come from your authenticated account.</p>
      </section>
      {error && <p className="form-error" role="alert">{error}</p>}
      <section className="customer-profile-details">
        <h2>Personal details</h2>
        <dl>
          <div><dt>Name</dt><dd>{profile.fullName}</dd></div>
          <div><dt>Email</dt><dd>{profile.email}</dd></div>
          <div><dt>Phone</dt><dd>{profile.phone}</dd></div>
          <div><dt>Identity verification</dt><dd>{profile.identityStatus.replaceAll('_', ' ')}</dd></div>
          <div><dt>Account activation</dt><dd>{profile.activationStatus.replaceAll('_', ' ')}</dd></div>
          {profile.referralCode && <div><dt>Referral code</dt><dd>{profile.referralCode}</dd></div>}
        </dl>
        <p>Identity documents are not collected. Contact support to request a verified profile change.</p>
      </section>
      <nav className="customer-profile-links" aria-label="Account settings">
        <Link href="/settings/security"><span><b>Password and security</b><small>Change your password and review sign-in protection</small></span><span aria-hidden="true">↗</span></Link>
        <Link href="/referrals"><span><b>Referrals</b><small>View your referral activity</small></span><span aria-hidden="true">↗</span></Link>
        <Link href="/support"><span><b>Contact support</b><small>Get help with your account</small></span><span aria-hidden="true">↗</span></Link>
      </nav>
    </main>
  );
}