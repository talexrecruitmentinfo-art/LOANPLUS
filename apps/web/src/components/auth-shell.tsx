import Link from 'next/link';
import type { ReactNode } from 'react';

interface AuthShellProps {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}

export function AuthShell({ eyebrow, title, description, children }: AuthShellProps) {
  return (
    <main className="auth-page">
      <section className="auth-aside">
        <Link className="wordmark auth-wordmark" href="/"><span className="brand-mark">L+</span> loanplus</Link>
        <div className="auth-aside-copy"><p className="eyebrow">CLEAR TERMS. THOUGHTFUL LENDING.</p><h1>Move forward<br /><em>with clarity.</em></h1><p>Your account keeps your information and any future financial activity in one secure place.</p></div>
        <span className="auth-aside-index">LOANPLUS / KENYA</span>
      </section>
      <section className="auth-main">
        <div className="auth-topline"><Link href="/">← Home</Link><span>KENYA · KSh</span></div>
        <div className="auth-form-wrap"><p className="eyebrow">{eyebrow}</p><h2>{title}</h2><p className="auth-description">{description}</p>{children}</div>
        <p className="auth-legal">By continuing, you agree to our <Link href="/terms">Terms</Link> and acknowledge our <Link href="/privacy">Privacy Policy</Link>.</p>
      </section>
    </main>
  );
}