import type { Metadata } from 'next';
import './styles.css';
import './auth.css';
import './products.css';
import './payments.css';
import './admin.css';

export const metadata: Metadata = {
  title: 'LoanPlus | Clearer borrowing, built around you',
  description: 'Explore responsible borrowing options and manage your LoanPlus account.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-KE">
      <body>{children}</body>
    </html>
  );
}