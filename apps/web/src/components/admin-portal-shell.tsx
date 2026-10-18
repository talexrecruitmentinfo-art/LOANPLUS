'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { apiRequest } from '@/lib/api';

const navigation = [
  { href: '/admin', label: 'Overview', group: 'OPERATIONS', icon: '◫' },
  { href: '/admin/customers', label: 'Customers', group: 'OPERATIONS', icon: '♙' },
  { href: '/admin/loans', label: 'Loans & review', group: 'OPERATIONS', icon: '▤' },
  { href: '/admin/disbursements', label: 'Disbursements', group: 'OPERATIONS', icon: '↗' },
  { href: '/admin/payments', label: 'Payments', group: 'FINANCE', icon: '▣' },
  { href: '/admin/reconciliation', label: 'Reconciliation', group: 'FINANCE', icon: '◎' },
  { href: '/admin/system-health', label: 'System health', group: 'FINANCE', icon: '⌁' },
  { href: '/admin/website', label: 'Website', group: 'MANAGEMENT', icon: '⌘' },
  { href: '/admin/support', label: 'Support', group: 'MANAGEMENT', icon: '?' },
  { href: '/admin/audit', label: 'Audit log', group: 'GOVERNANCE', icon: '≡' },
  { href: '/admin/settings', label: 'Settings', group: 'GOVERNANCE', icon: '⚙' },
];

export default function AdminPortalShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [logoutError, setLogoutError] = useState('');

  useEffect(() => setMenuOpen(false), [pathname]);

  if (pathname === '/admin/login') return children;

  async function logout() {
    setLogoutError('');
    try {
      await apiRequest('/admin/auth/logout', { method: 'POST', body: '{}' });
      router.replace('/admin/login');
    } catch (reason) {
      setLogoutError(reason instanceof Error ? reason.message : 'Could not end the administrator session.');
    }
  }

  const activeItem = navigation.find((item) => item.href !== '/admin' && pathname.startsWith(`${item.href}/`))
    ?? navigation.find((item) => item.href === pathname)
    ?? navigation[0];
  const groups = [...new Set(navigation.map((item) => item.group))];

  return (
    <div className="admin-portal">
      <aside className={`admin-sidebar${menuOpen ? ' admin-sidebar-open' : ''}`} aria-label="Admin portal">
        <Link className="admin-brand" href="/admin">
          <span className="admin-brand-mark" aria-hidden="true">L+</span>
          <span><b>LoanPlus</b><small>ADMINISTRATION</small></span>
        </Link>
        <nav className="admin-side-navigation" aria-label="Administration sections">
          {groups.map((group) => (
            <div className="admin-nav-group" key={group}>
              <span className="admin-nav-group-title">{group}</span>
              {navigation.filter((item) => item.group === group).map((item) => {
                const active = item.href === '/admin'
                  ? pathname === item.href
                  : pathname === item.href || pathname.startsWith(`${item.href}/`);
                return (
                  <Link key={item.href} href={item.href} aria-current={active ? 'page' : undefined}>
                    <span className="admin-nav-icon" aria-hidden="true">{item.icon}</span>
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="admin-sidebar-footer">
          <span className="admin-session-indicator" aria-hidden="true" />
          <span><b>OTP-protected access</b><small>Superadmin sign-in</small></span>
        </div>
      </aside>
      {menuOpen && <button className="admin-sidebar-backdrop" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}
      <div className="admin-portal-main">
        <header className="admin-topbar">
          <button
            className="admin-menu-toggle"
            type="button"
            aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span aria-hidden="true">☰</span>
          </button>
          <div className="admin-breadcrumb"><span>Administration</span><b aria-hidden="true">/</b><strong>{activeItem.label}</strong></div>
          <div className="admin-topbar-actions">
            <span className="admin-access-badge">SUPERADMIN</span>
            <button className="admin-logout-button" type="button" onClick={() => void logout()}>Log out</button>
          </div>
        </header>
        {logoutError && <p className="admin-shell-error" role="alert">{logoutError}</p>}
        <div className="admin-portal-content">{children}</div>
      </div>
    </div>
  );
}
