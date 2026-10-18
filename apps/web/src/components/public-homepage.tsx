'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { apiRequest, resolveApiAsset } from '@/lib/api';

interface WebsiteContent {
  branding: { name: string; tagline: string; primaryColor: string; accentColor: string; logo: string };
  hero: {
    eyebrow: string; headline: string; highlight: string; description: string;
    primaryLabel: string; primaryHref: string; secondaryLabel: string; secondaryHref: string;
    eligibilityNote: string; image: string;
  };
  navigation: Array<{ id: string; label: string; href: string; visible: boolean }>;
  features: Array<{ id: string; title: string; description: string; icon: string; visible: boolean }>;
  steps: Array<{ id: string; title: string; description: string; icon: string; visible: boolean }>;
  faqs: Array<{ id: string; question: string; answer: string; visible: boolean }>;
  footer: { note: string; privacyLabel: string; termsLabel: string };
  seo: { title: string; description: string; socialTitle: string; socialDescription: string; socialImage: string };
}

const defaultContent: WebsiteContent = {
  branding: { name: 'LoanPlus', tagline: 'Clear terms. Thoughtful lending.', primaryColor: '#14563f', accentColor: '#d4ed91', logo: '' },
  hero: {
    eyebrow: 'FAST · SECURE · TRANSPARENT',
    headline: 'Get the financial support you need,',
    highlight: 'when you need it.',
    description: 'Explore straightforward loan options, understand the costs upfront, and track your application from your phone.',
    primaryLabel: 'Create an account', primaryHref: '/register',
    secondaryLabel: 'How it works', secondaryHref: '#how-it-works',
    eligibilityNote: 'For eligible applicants in Kenya · Amounts in KSh', image: '',
  },
  navigation: [
    { id: 'how', label: 'How it works', href: '#how-it-works', visible: true },
    { id: 'features', label: 'Why LoanPlus', href: '#features', visible: true },
    { id: 'faqs', label: 'FAQs', href: '#faqs', visible: true },
    { id: 'terms', label: 'Terms', href: '/terms', visible: true },
  ],
  features: [
    { id: 'application', title: 'Straightforward application', description: 'Follow a clear, guided application and provide the information needed for review.', icon: '↗', visible: true },
    { id: 'costs', title: 'Costs shown upfront', description: 'Review applicable charges and terms before deciding whether to accept an offer.', icon: 'KSh', visible: true },
    { id: 'secure', title: 'Secure account access', description: 'Sign in to manage your account using the existing LoanPlus security controls.', icon: '✓', visible: true },
    { id: 'tracking', title: 'Track application status', description: 'See application updates from your account while your request is reviewed.', icon: '◎', visible: true },
    { id: 'mobile', title: 'Designed for mobile', description: 'Access LoanPlus from your phone, tablet or desktop browser.', icon: '↗', visible: true },
    { id: 'support', title: 'Customer support', description: 'Find support options from within your LoanPlus account.', icon: '?', visible: true },
  ],
  steps: [
    { id: 'register', title: 'Register and sign in', description: 'Create your account and sign in securely.', icon: '01', visible: true },
    { id: 'apply', title: 'Complete your application', description: 'Provide the requested details, including required guarantor information.', icon: '02', visible: true },
    { id: 'review', title: 'Review your details and terms', description: 'Check your application information and applicable terms before proceeding.', icon: '03', visible: true },
    { id: 'pay', title: 'Pay the processing fee', description: 'Review the configured loan processing fee and its approved refund policy before continuing to M-Pesa.', icon: '04', visible: true },
    { id: 'submit', title: 'Submit after payment confirmation', description: 'Your application is submitted only after the payment is authoritatively confirmed.', icon: '05', visible: true },
    { id: 'track', title: 'Track the review', description: 'Follow your application while it awaits Admin review. The processing fee does not guarantee approval.', icon: '06', visible: true },
  ],
  faqs: [
    { id: 'fee', question: 'What is the loan processing fee?', answer: 'The fee is displayed from the LoanPlus payment service before you proceed. It is not an account activation fee and does not guarantee loan approval or disbursement.', visible: true },
    { id: 'approval', question: 'Does paying the fee guarantee approval?', answer: 'No. Applications are reviewed individually by LoanPlus administrators. Payment does not guarantee approval or disbursement.', visible: true },
    { id: 'status', question: 'How do I track my application?', answer: 'Sign in to your LoanPlus account to view your application status and updates.', visible: true },
  ],
  footer: { note: 'Kenya · Clear terms. Thoughtful lending.', privacyLabel: 'Privacy', termsLabel: 'Terms' },
  seo: {
    title: 'LoanPlus | Clearer borrowing, built around you',
    description: 'Explore responsible borrowing options and manage your LoanPlus account.',
    socialTitle: 'LoanPlus',
    socialDescription: 'Explore straightforward loan options with clear terms.',
    socialImage: '',
  },
};

interface PublishedWebsite {
  content: WebsiteContent;
  processingFeeKes: number | null;
}

function Website({ content, fee }: { content: WebsiteContent; fee: number | null }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const visibleNavigation = content.navigation.filter((item) => item.visible);
  const cssVariables = {
    '--site-green': content.branding.primaryColor,
    '--site-accent': content.branding.accentColor,
  } as CSSProperties;

  return (
    <main className="marketing-site" style={cssVariables}>
      <header className="site-header">
        <Link className="site-wordmark" href="/" aria-label={`${content.branding.name} home`}>
          {content.branding.logo ? <img src={resolveApiAsset(content.branding.logo)} alt="" /> : <span className="site-mark">L+</span>}
          <span><b>{content.branding.name}</b><small>{content.branding.tagline}</small></span>
        </Link>
        <button className="site-menu-toggle" type="button" aria-expanded={menuOpen} aria-controls="site-navigation" onClick={() => setMenuOpen((open) => !open)}>
          <span aria-hidden="true">{menuOpen ? '×' : '☰'}</span><span className="sr-only">{menuOpen ? 'Close' : 'Open'} navigation menu</span>
        </button>
        <nav className={menuOpen ? 'site-navigation is-open' : 'site-navigation'} id="site-navigation" aria-label="Public navigation">
          {visibleNavigation.map((item) => <a key={item.id} href={item.href} onClick={() => setMenuOpen(false)}>{item.label}</a>)}
          <div className="site-mobile-actions">
            <a href="/login">Log in</a><a className="site-button site-button-small" href="/register">Get started <span aria-hidden="true">↗</span></a>
          </div>
        </nav>
        <div className="site-header-actions"><a href="/login">Log in</a><a className="site-button site-button-small" href="/register">Get started <span aria-hidden="true">↗</span></a></div>
      </header>

      <section className="site-hero">
        <div className="site-hero-copy">
          <p className="site-eyebrow"><span aria-hidden="true" />{content.hero.eyebrow}</p>
          <h1>{content.hero.headline} <em>{content.hero.highlight}</em></h1>
          <p className="site-lede">{content.hero.description}</p>
          <div className="site-hero-actions">
            <a className="site-button" href={content.hero.primaryHref}>{content.hero.primaryLabel}<span aria-hidden="true">↗</span></a>
            <a className="site-text-button" href={content.hero.secondaryHref}>{content.hero.secondaryLabel}<span aria-hidden="true">↓</span></a>
          </div>
          <p className="site-eligibility">{content.hero.eligibilityNote}</p>
        </div>
        <div className={content.hero.image ? 'site-hero-visual has-image' : 'site-hero-visual'} aria-label={content.hero.image ? 'LoanPlus brand illustration' : undefined} role={content.hero.image ? 'img' : undefined}>
          {content.hero.image ? <img src={resolveApiAsset(content.hero.image)} alt="" /> : <div className="site-orbit" aria-hidden="true"><span className="site-orbit-disc" /><span className="site-orbit-ring site-orbit-ring-one" /><span className="site-orbit-ring site-orbit-ring-two" /></div>}
          <div className="site-visual-note"><span className="site-note-icon">✓</span><span><b>Know before you borrow</b><small>Review your terms before accepting</small></span></div>
          <span className="site-visual-caption">Clear terms / A thoughtful start</span>
        </div>
      </section>

      <section className="site-commitments" aria-label="Our commitments">
        <b>Built on clear terms</b><span>Responsible application review</span><span>Costs shown before you proceed</span><span>Your information matters</span>
      </section>

      {content.features.some((feature) => feature.visible) && <section className="site-features" id="features">
        <div className="site-section-heading"><p className="site-eyebrow">A CLEARER WAY FORWARD</p><h2>Designed around<br /><em>your next step.</em></h2><p>Tools and information to help you understand the process before you apply.</p></div>
        <div className="site-feature-grid">{content.features.filter((feature) => feature.visible).map((feature) => <article className="site-feature-card" key={feature.id}><span className="site-feature-icon" aria-hidden="true">{feature.icon}</span><h3>{feature.title}</h3><p>{feature.description}</p></article>)}</div>
      </section>}

      <section className="site-steps" id="how-it-works">
        <div className="site-section-heading"><p className="site-eyebrow">A SIMPLE PLACE TO START</p><h2>One clear step<br /><em>at a time.</em></h2><p>Here is how a LoanPlus application moves from start to review.</p></div>
        <ol className="site-step-list">{content.steps.filter((step) => step.visible).map((step, index) => <li key={step.id}><span className="site-step-index">{String(index + 1).padStart(2, '0')}</span><div><h3>{step.title}</h3><p>{step.description}</p></div><span className="site-step-symbol" aria-hidden="true">{step.icon}</span></li>)}</ol>
      </section>

      <section className="site-fee" id="processing-fee">
        <span className="site-fee-symbol" aria-hidden="true">KSh</span>
        <div><p className="site-eyebrow">LOAN PROCESSING FEE</p><h2>{fee === null ? 'Fee information unavailable' : `KSh ${fee.toLocaleString('en-KE')}`}</h2><p>This fee relates to a loan application, not account activation. Payment does not guarantee approval or disbursement. Your application awaits Admin review after authoritative payment confirmation.</p></div>
        <a href="/terms">Review terms <span aria-hidden="true">↗</span></a>
      </section>

      {content.faqs.some((faq) => faq.visible) && <section className="site-faq" id="faqs">
        <div className="site-section-heading"><p className="site-eyebrow">QUESTIONS, ANSWERED</p><h2>Good to<br /><em>know.</em></h2></div>
        <div className="site-faq-list">{content.faqs.filter((faq) => faq.visible).map((faq) => <details key={faq.id}><summary>{faq.question}<span aria-hidden="true">+</span></summary><p>{faq.answer}</p></details>)}</div>
      </section>}

      <section className="site-final-cta"><p className="site-eyebrow">START WHEN YOU&apos;RE READY</p><h2>Understand the details.<br /><em>Then decide.</em></h2><p>Explore LoanPlus and review the applicable terms before you apply.</p><a className="site-button site-button-light" href="/register">Create your account <span aria-hidden="true">↗</span></a></section>

      <footer className="site-footer">
        <Link className="site-wordmark site-footer-wordmark" href="/"><span className="site-mark">L+</span><span><b>{content.branding.name}</b><small>{content.branding.tagline}</small></span></Link>
        <p>{content.footer.note}</p>
        <div><a href="/privacy">{content.footer.privacyLabel}</a><a href="/terms">{content.footer.termsLabel}</a><a href="/login">Customer support</a></div>
        <small>© {new Date().getFullYear()} {content.branding.name}</small>
      </footer>
    </main>
  );
}

export default function HomePage() {
  const [published, setPublished] = useState<PublishedWebsite>({ content: defaultContent, processingFeeKes: null });
  useEffect(() => {
    let active = true;
    void apiRequest<PublishedWebsite>('/platform/website')
      .then((result) => { if (active) setPublished(result); })
      .catch(() => { if (active) setPublished({ content: defaultContent, processingFeeKes: null }); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    document.title = published.content.seo.title;
    const description = document.querySelector('meta[name="description"]');
    description?.setAttribute('content', published.content.seo.description);
    const socialTitle = document.querySelector('meta[property="og:title"]');
    socialTitle?.setAttribute('content', published.content.seo.socialTitle);
    const socialDescription = document.querySelector('meta[property="og:description"]');
    socialDescription?.setAttribute('content', published.content.seo.socialDescription);
    const socialImage = document.querySelector('meta[property="og:image"]');
    if (socialImage && published.content.seo.socialImage) socialImage.setAttribute('content', published.content.seo.socialImage);
    const twitterTitle = document.querySelector('meta[name="twitter:title"]');
    twitterTitle?.setAttribute('content', published.content.seo.socialTitle);
    const twitterDescription = document.querySelector('meta[name="twitter:description"]');
    twitterDescription?.setAttribute('content', published.content.seo.socialDescription);
  }, [published.content]);
  return <Website content={published.content} fee={published.processingFeeKes} />;
}
