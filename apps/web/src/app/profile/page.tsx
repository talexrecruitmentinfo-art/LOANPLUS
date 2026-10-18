'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiRequest } from '@/lib/api';

interface CustomerProfile {
  fullName: string;
  email: string;
  phone: string;
  identityStatus: string;
  referralCode: string | null;
}

export default function ProfilePage() {
  const router = useRouter();
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const loadProfile = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setProfile(await apiRequest<CustomerProfile>('/auth/me', { cache: 'no-store' }));
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Your profile could not be loaded.';
      if (message.includes('Authentication required')) {
        router.replace('/login');
      } else {
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => { void loadProfile(); }, [loadProfile]);

  async function logout() {
    try {
      await apiRequest('/auth/logout', { method: 'POST', body: '{}' });
      router.replace('/login');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Sign out could not be completed.');
    }
  }

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
      {loading ? <p className="customer-profile-details" role="status">Loading your profile…</p> : profile ? (
        <>
          <section className="customer-profile-details">
            <h2>Personal details</h2>
            <dl>
              <div><dt>Name</dt><dd>{profile.fullName}</dd></div>
              <div><dt>Email</dt><dd>{profile.email}</dd></div>
              <div><dt>Phone</dt><dd>{profile.phone}</dd></div>
              <div><dt>Identity verification</dt><dd><span className="status-label">{profile.identityStatus.replaceAll('_', ' ')}</span></dd></div>
              {profile.referralCode && <div><dt>Referral code</dt><dd>{profile.referralCode}</dd></div>}
            </dl>
            <p>Identity documents are not collected. Contact support to request a verified profile change.</p>
          </section>
          <nav className="customer-profile-links" aria-label="Account settings">
            <Link href="/settings/security"><span><b>Password and security</b><small>Change your password and review sign-in protection</small></span><span aria-hidden="true">↗</span></Link>
            <Link href="/trust"><span><b>Trust Centre</b><small>Review fees, privacy, and account protection</small></span><span aria-hidden="true">↗</span></Link>
            <Link href="/referrals"><span><b>Referrals</b><small>View your referral activity</small></span><span aria-hidden="true">↗</span></Link>
            <Link href="/support"><span><b>Contact support</b><small>Get help with your account</small></span><span aria-hidden="true">↗</span></Link>
          </nav>
        </>
      ) : (
        <section className="customer-profile-details" aria-labelledby="profile-error-heading">
          <h2 id="profile-error-heading">Profile unavailable</h2>
          <p>We couldn’t load your account details. You can try again or sign in again if your session has expired.</p>
          <button className="quiet-button" type="button" onClick={() => void loadProfile()}>Retry</button>
          <Link className="legal-home" href="/login">Sign in</Link>
        </section>
      )}
    </main>
  );
}