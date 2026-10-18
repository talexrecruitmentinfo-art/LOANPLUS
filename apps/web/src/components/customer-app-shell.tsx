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
  '/dashboard', '/activation', '/loans', '/wallet', '/transactions', '/profile',
  '/referrals', '/support', '/settings/security',
];

const navigationItems = [
  { href: '/dashboard', label: 'Home' },
  { href: '/wallet', label: 'Wallet' },
  { href: '/loans', label: 'Loans' },
  { href: '/transactions', label: 'Activity' },
  { href: '/profile', label: 'Profile' },
];

const adminNavigationItems = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/customers', label: 'Customers' },
  { href: '/admin/payments', label: 'Payments' },
  { href: '/admin/reconciliation', label: 'Reconciliation' },
  { href: '/admin/loans', label: 'Loans' },
  { href: '/admin/audit', label: 'Audit' },
  { href: '/admin/settings', label: 'Settings' },
];

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
              {item.label}
            </Link>
          );
        })}
        {installEligible && !installed && (
          <details className="customer-install-menu">
            <summary>Install app</summary>
            <div className="customer-install-help">
              {installPrompt ? (
                <button type="button" onClick={() => void installApp()}>Install LoanPlus</button>
              ) : isIos ? (
                <p>In Safari, tap Share, then Add to Home Screen.</p>
              ) : (
                <p>Use your browser menu and choose Install app or Add to Home screen.</p>
              )}
            </div>
          </details>
        )}
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