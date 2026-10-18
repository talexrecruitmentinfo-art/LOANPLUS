'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { apiRequest } from '@/lib/api';

type BeforeInstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

const customerRoutes = [
  '/dashboard', '/loans', '/wallet', '/transactions', '/profile',
  '/referrals', '/support', '/trust', '/settings/security',
];

const navigationItems = [
  { href: '/dashboard', label: 'Home', icon: 'home' },
  { href: '/loans', label: 'Loans', icon: 'loans' },
  { href: '/wallet', label: 'Wallet', icon: 'wallet' },
  { href: '/transactions', label: 'Payments', icon: 'payments' },
  { href: '/profile', label: 'Profile', icon: 'profile' },
];

const adminNavigationItems = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/customers', label: 'Customers' },
  { href: '/admin/payments', label: 'Payments' },
  { href: '/admin/reconciliation', label: 'Reconciliation' },
  { href: '/admin/loans', label: 'Loans' },
  { href: '/admin/website', label: 'Website' },
  { href: '/admin/audit', label: 'Audit' },
  { href: '/admin/settings', label: 'Settings' },
];

function NavigationIcon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    home: <><path d="m3 10 9-7 9 7" /><path d="M5 9v11h14V9M9 20v-6h6v6" /></>,
    loans: <><path d="M4 5.5 12 2l8 3.5v5c0 5-3.4 8.2-8 11-4.6-2.8-8-6-8-11z" /><path d="M8 11h8M8 15h5" /></>,
    wallet: <><rect x="3" y="5" width="18" height="15" rx="2" /><path d="M3 9h18M16 14h2" /><path d="M6 5V3h12v2" /></>,
    payments: <><path d="M4 4h16v16H4z" /><path d="M8 8h8M8 12h8M8 16h4" /></>,
    profile: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c.5-3.4 3-5.5 7-5.5s6.5 2.1 7 5.5" /></>,
    more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function CustomerNavigation({ pathname }: { pathname: string }) {
  const [installEligible, setInstallEligible] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPrompt | null>(null);
  const [installed, setInstalled] = useState(false);
  const [isIos, setIsIos] = useState(false);

  useEffect(() => {
    const standalone = window.matchMedia('(display-mode: standalone)').matches ||
      ('standalone' in navigator && Boolean((navigator as Navigator & { standalone?: boolean }).standalone));
    setInstalled(standalone);
    setIsIos(/iPad|iPhone|iPod/.test(navigator.userAgent));

    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPrompt);
    };
    const onInstalled = () => setInstalled(true);
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);

    if ('serviceWorker' in navigator && window.isSecureContext) {
      void navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
        .then((registration) => registration.update())
        .catch(() => undefined);
    }
    void apiRequest<{ eligible: boolean }>('/platform/pwa/eligibility', { cache: 'no-store' })
      .then((result) => setInstallEligible(result.eligible))
      .catch(() => setInstallEligible(false));

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  async function installApp() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  }

  return (
    <>
      <nav className="customer-app-nav" aria-label="Customer navigation">
        {navigationItems.map((item) => {
          const active = pathname === item.href || (item.href !== '/dashboard' && pathname.startsWith(`${item.href}/`));
          return (
            <Link key={item.href} href={item.href} aria-current={active ? 'page' : undefined}>
              <NavigationIcon name={item.icon} />
              <span>{item.label}</span>
            </Link>
          );
        })}
        <details className="customer-more-menu">
          <summary aria-label="More customer options"><NavigationIcon name="more" /><span>More</span></summary>
          <div className="customer-more-panel">
            <Link href="/support">Support <span aria-hidden="true">↗</span></Link>
            <Link href="/trust">Trust Centre <span aria-hidden="true">↗</span></Link>
            <Link href="/settings/security">Security <span aria-hidden="true">↗</span></Link>
            <Link href="/referrals">Referrals <span aria-hidden="true">↗</span></Link>
            {installEligible && !installed && (
              <div className="customer-install-help">
                {installPrompt ? (
                  <button type="button" onClick={() => void installApp()}>Install LoanPlus</button>
                ) : isIos ? (
                  <p>In Safari, tap Share, then Add to Home Screen.</p>
                ) : (
                  <p>Use your browser menu and choose Install app or Add to Home screen.</p>
                )}
              </div>
            )}
          </div>
        </details>
      </nav>
    </>
  );
}

export default function CustomerAppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isCustomerRoute = customerRoutes.some((route) => pathname === route || pathname.startsWith(`${route}/`));
  const isAdminRoute = pathname.startsWith('/admin') && pathname !== '/admin/login';

  useEffect(() => {
    if (!isCustomerRoute && 'serviceWorker' in navigator && window.isSecureContext) {
      void navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
        .then((registration) => registration.update())
        .catch(() => undefined);
    }
  }, [isCustomerRoute]);

  return (
    <div className={isCustomerRoute ? 'customer-app-shell' : isAdminRoute ? 'admin-app-shell' : undefined}>
      {children}
      {isCustomerRoute && <CustomerNavigation pathname={pathname} />}
      {isAdminRoute && <nav className="admin-app-nav" aria-label="Administration navigation">
        {adminNavigationItems.map((item) => {
          const active = pathname === item.href;
          return <Link key={item.href} href={item.href} aria-current={active ? 'page' : undefined}>{item.label}</Link>;
        })}
      </nav>}
    </div>
  );
}