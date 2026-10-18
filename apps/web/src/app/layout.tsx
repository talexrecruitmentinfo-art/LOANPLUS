import type { Metadata, Viewport } from 'next';
import './styles.css';
import './auth.css';
import './products.css';
import './payments.css';
import './admin.css';
import './admin-review.css';
import './customer-ledger.css';
import './customer-app.css';
import './navigation-overrides.css';
import './customer-redesign.css';
import CustomerAppShell from '@/components/customer-app-shell';

export const metadata: Metadata = {
  title: 'LoanPlus | Clearer borrowing, built around you',
  description: 'Explore responsible borrowing options and manage your LoanPlus account.',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'LoanPlus' },
  icons: {
    icon: [
      { url: '/icons/loanplus-192.png', type: 'image/png', sizes: '192x192' },
      { url: '/icons/loanplus-192.svg', type: 'image/svg+xml', sizes: '192x192' },
      { url: '/icons/loanplus-512.png', type: 'image/png', sizes: '512x512' },
      { url: '/icons/loanplus-512.svg', type: 'image/svg+xml', sizes: '512x512' },
    ],
    apple: [{ url: '/icons/loanplus-apple.png', type: 'image/png', sizes: '180x180' }],
  },
};

export const viewport: Viewport = { themeColor: '#1d503b' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-KE">
      <body><CustomerAppShell>{children}</CustomerAppShell></body>
    </html>
  );
}