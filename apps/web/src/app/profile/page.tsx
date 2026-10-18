'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiRequest } from '@/lib/api';

type BeforeInstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

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
  const [installEligible, setInstallEligible] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPrompt | null>(null);
  const [installed, setInstalled] = useState(false);
  const [isIos, setIsIos] = useState(false);
  const [installError, setInstallError] = useState('');

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

  useEffect(() => {
    setInstalled(window.matchMedia('(display-mode: standalone)').matches ||
      ('standalone' in navigator && Boolean((navigator as Navigator & { standalone?: boolean }).standalone)));
    setIsIos(/iPad|iPhone|iPod/.test(navigator.userAgent));
    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPrompt);
    };
    const onInstalled = () => setInstalled(true);
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    void apiRequest<{ eligible: boolean }>('/platform/pwa/eligibility', { cache: 'no-store' })
      .then((result) => setInstallEligible(result.eligible))
      .catch((reason: unknown) => setInstallError(reason instanceof Error ? reason.message : 'Installation options could not be loaded.'));
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  async function installApp() {
    if (!installPrompt) return;
    setInstallError('');
    try {
      await installPrompt.prompt();
      await installPrompt.userChoice;
      setInstallPrompt(null);
    } catch (reason) {
      setInstallError(reason instanceof Error ? reason.message : 'LoanPlus could not be installed from this browser.');
    }
  }

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
          <section className="customer-profile-details" id="personal-information">
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
            <Link href="#personal-information"><span><b>Personal information</b><small>View details associated with your account</small></span><span aria-hidden="true">↗</span></Link>
            <Link href="/trust"><span><b>Identity verification</b><small>Review your verification status and trust information</small></span><span aria-hidden="true">↗</span></Link>
            <Link href="/settings/security"><span><b>Security settings</b><small>Change your password and review sign-in protection</small></span><span aria-hidden="true">↗</span></Link>
            <Link href="/referrals"><span><b>Referrals</b><small>View your referral activity</small></span><span aria-hidden="true">↗</span></Link>
            <Link href="/trust"><span><b>Trust Centre</b><small>Review fees, privacy, and account protection</small></span><span aria-hidden="true">↗</span></Link>
            <Link href="/support"><span><b>Help and support</b><small>Get help with your account</small></span><span aria-hidden="true">↗</span></Link>
            <Link href="/terms"><span><b>Terms and conditions</b><small>Read the published terms</small></span><span aria-hidden="true">↗</span></Link>
            <Link href="/privacy"><span><b>Privacy</b><small>Read the published privacy information</small></span><span aria-hidden="true">↗</span></Link>
            {installEligible && !installed && <div className="customer-install-help">
              <b>Install LoanPlus</b>
              {installPrompt ? <button type="button" onClick={() => void installApp()}>Install LoanPlus</button> : isIos
                ? <p>In Safari, tap Share, then Add to Home Screen.</p>
                : <p>Use your browser menu and choose Install app or Add to home screen.</p>}
              <small>This adds an app shortcut; it does not remove LoanPlus from any device.</small>
            </div>}
          </nav>
          {installError && <p className="form-error" role="alert">{installError}</p>}
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