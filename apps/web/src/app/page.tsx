import Link from 'next/link';

const steps = [
  { number: '01', title: 'Create your account', description: 'Register with your details and keep your account secure.' },
  { number: '02', title: 'Explore your options', description: 'Review available products, costs and repayment dates before applying.' },
  { number: '03', title: 'Get a clear decision', description: 'Applications are reviewed individually. Applying does not guarantee approval.' },
];

export default function HomePage() {
  return (
    <main>
      <header className="topbar">
        <Link className="wordmark" href="/" aria-label="LoanPlus home"><span className="brand-mark">L+</span> loanplus</Link>
        <nav aria-label="Main navigation">
          <a href="#how-it-works">How it works</a>
          <a href="#responsible-lending">Responsible lending</a>
        </nav>
        <div className="nav-actions">
          <a className="text-link" href="/login">Log in</a>
          <a className="button button-small" href="/register">Get started <span aria-hidden="true">↗</span></a>
        </div>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow"><span className="status-dot" /> BORROWING, WITH CLARITY</p>
          <h1>Make room<br />for <em>what&apos;s next.</em></h1>
          <p className="hero-description">Explore straightforward loan options designed around your plans. Clear terms, thoughtful review, and no promises we can&apos;t keep.</p>
          <div className="hero-actions">
            <a className="button" href="/register">Create an account <span aria-hidden="true">↗</span></a>
            <a className="quiet-link" href="#how-it-works">See how it works <span aria-hidden="true">↓</span></a>
          </div>
          <p className="hero-note">For eligible applicants in Kenya · Amounts in KSh</p>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="sun-disc" />
          <div className="arc arc-one" />
          <div className="arc arc-two" />
          <div className="floating-note"><span className="note-icon">↗</span><span><b>Know before you borrow</b><small>Terms shown before you accept</small></span></div>
          <span className="art-caption">A clearer way forward / 01</span>
        </div>
      </section>

      <section className="trust-strip" aria-label="Our commitments">
        <p>Built on clear terms</p><span>01 / No guaranteed approvals</span><span>02 / Review costs up front</span><span>03 / Your information matters</span>
      </section>

      <section className="steps-section" id="how-it-works">
        <div className="section-heading"><p className="eyebrow">A SIMPLE PLACE TO START</p><h2>Three steps.<br /><em>No surprises.</em></h2></div>
        <div className="steps-list">{steps.map((step) => <article className="step" key={step.number}><span className="step-number">{step.number}</span><div><h3>{step.title}</h3><p>{step.description}</p></div><span className="step-arrow" aria-hidden="true">↗</span></article>)}</div>
      </section>

      <section className="responsible" id="responsible-lending"><span className="responsible-mark" aria-hidden="true">i</span><div><p className="eyebrow">A NOTE ON RESPONSIBLE BORROWING</p><h2>Borrow only what<br />you can repay.</h2><p>Loan availability, charges and eligibility depend on the product and your application. Review the full repayment amount and dates before accepting an offer. The Loan Processing Fee — KSh 50 does not guarantee approval or disbursement.</p></div><a href="/terms">Read our terms <span aria-hidden="true">↗</span></a></section>

      <footer><Link className="wordmark" href="/"><span className="brand-mark">L+</span> loanplus</Link><p>Kenya · Clear terms. Thoughtful lending.</p><div><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/support">Support</a></div><small>© {new Date().getFullYear()} LoanPlus</small></footer>
    </main>
  );
}