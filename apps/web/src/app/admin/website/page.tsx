'use client';

import Link from 'next/link';
import { useEffect, useState, type ChangeEvent, type CSSProperties, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
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

const initialContent: WebsiteContent = {
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
    { id: 'pay', title: 'Pay the processing fee', description: 'Pay the KSh 50 loan processing fee through the existing M-Pesa flow.', icon: '04', visible: true },
    { id: 'submit', title: 'Submit after payment confirmation', description: 'Your application is submitted only after the payment is authoritatively confirmed.', icon: '05', visible: true },
    { id: 'track', title: 'Track the review', description: 'Follow your application while it awaits Admin review. The processing fee does not guarantee approval.', icon: '06', visible: true },
  ],
  faqs: [
    { id: 'fee', question: 'What is the loan processing fee?', answer: 'The KSh 50 loan processing fee is payable through the existing M-Pesa flow. It is not an account activation fee and does not guarantee loan approval or disbursement.', visible: true },
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

interface WebsiteState {
  draft: { version: number; updatedAt: string; updatedBy?: string; content: WebsiteContent } | null;
  published: { version: number; publishedAt: string; publishedBy: string | null } | null;
  processingFeeKes: number;
}

interface Revision {
  version: number;
  status: string;
  createdAt: string;
  createdBy: string;
  publishedAt: string | null;
  publishedBy: string | null;
}

const coreSteps = new Set(['register', 'apply', 'review', 'pay', 'submit', 'track']);
const allowedIcons = ['↗', 'KSh', '✓', '◎', '?'];

function imageSrc(url: string) {
  return url ? resolveApiAsset(url) : undefined;
}

export default function AdminWebsitePage() {
  const router = useRouter();
  const [content, setContent] = useState<WebsiteContent>(initialContent);
  const [version, setVersion] = useState(0);
  const [published, setPublished] = useState<WebsiteState['published']>(null);
  const [fee, setFee] = useState(50);
  const [history, setHistory] = useState<Revision[]>([]);
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function refresh() {
    const [state, revisions] = await Promise.all([
      apiRequest<WebsiteState>('/admin/website', { cache: 'no-store' }),
      apiRequest<Revision[]>('/admin/website/history', { cache: 'no-store' }),
    ]);
    setContent(state.draft?.content ?? initialContent);
    setVersion(state.draft?.version ?? 0);
    setPublished(state.published);
    setFee(state.processingFeeKes);
    setHistory(revisions);
    setDirty(false);
  }

  useEffect(() => {
    void refresh().catch((reason: unknown) => {
      if (reason instanceof Error && reason.message.includes('Authentication required')) router.replace('/admin/login');
      else setError(reason instanceof Error ? reason.message : 'Website content could not be loaded.');
    });
  }, [router]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function update<K extends keyof WebsiteContent>(section: K, values: Partial<WebsiteContent[K]>) {
    setContent((current) => ({ ...current, [section]: { ...current[section], ...values } }));
    setDirty(true);
    setNotice('');
  }

  function setArray<K extends 'navigation' | 'features' | 'steps' | 'faqs'>(
    section: K,
    values: WebsiteContent[K],
  ) {
    setContent((current) => ({ ...current, [section]: values }));
    setDirty(true);
    setNotice('');
  }

  async function uploadImage(event: ChangeEvent<HTMLInputElement>, target: 'logo' | 'hero' | 'social') {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      setError('Choose a PNG, JPEG or WebP image no larger than 5 MB.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('The selected image could not be read.'));
        reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('The selected image could not be read.'));
        reader.readAsDataURL(file);
      });
      const uploaded = await apiRequest<{ url: string }>('/admin/website/assets', {
        method: 'POST',
        body: JSON.stringify({ data, mimeType: file.type }),
      });
      if (target === 'logo') update('branding', { logo: uploaded.url });
      if (target === 'hero') update('hero', { image: uploaded.url });
      if (target === 'social') update('seo', { socialImage: uploaded.url });
      setNotice('Image uploaded and ready to save with the draft.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The image could not be uploaded.');
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft() {
    const saved = await apiRequest<{ version: number }>('/admin/website/draft', {
      method: 'PUT',
      body: JSON.stringify({ content, expectedVersion: version }),
    });
    setVersion(saved.version);
    setDirty(false);
    setNotice(`Draft v${saved.version} saved. It is not public until you publish it.`);
  }

  async function submitSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await saveDraft();
      setHistory(await apiRequest<Revision[]>('/admin/website/history', { cache: 'no-store' }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The website draft could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!window.confirm('Publish this website version for all public visitors? This replaces the current live version.')) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      let targetVersion = version;
      if (dirty || targetVersion === 0) {
        const saved = await apiRequest<{ version: number }>('/admin/website/draft', {
          method: 'PUT',
          body: JSON.stringify({ content, expectedVersion: version }),
        });
        targetVersion = saved.version;
      }
      const result = await apiRequest<{ version: number; publishedAt: string }>('/admin/website/publish', {
        method: 'POST',
        body: JSON.stringify({ expectedVersion: targetVersion }),
      });
      setVersion(result.version);
      setDirty(false);
      await refresh();
      setNotice(`Website version ${result.version} is now published.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The website could not be published.');
    } finally {
      setBusy(false);
    }
  }

  async function discardDraft() {
    if (!window.confirm('Discard the saved draft and reset your unsaved edits? This cannot be undone.')) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiRequest('/admin/website/draft', { method: 'DELETE' });
      await refresh();
      setNotice('Draft discarded. The published website was not changed.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The website draft could not be discarded.');
    } finally {
      setBusy(false);
    }
  }

  function reorder<T>(items: T[], index: number, delta: number): T[] {
    const destination = index + delta;
    if (destination < 0 || destination >= items.length) return items;
    const reordered = [...items];
    [reordered[index], reordered[destination]] = [reordered[destination], reordered[index]];
    return reordered;
  }

  const contentPreview = <div className="website-draft-preview" style={{ '--site-green': content.branding.primaryColor } as CSSProperties}>
    <div className="website-preview-banner">DRAFT PREVIEW · Not visible to public</div>
    <header><span className="website-preview-logo">{content.branding.logo ? <img src={imageSrc(content.branding.logo)} alt="" /> : 'L+'}<b>{content.branding.name}</b></span><span>{content.navigation.filter((item) => item.visible).map((item) => item.label).join(' · ')}</span></header>
    <section className="website-preview-hero"><small>{content.hero.eyebrow}</small><h1>{content.hero.headline} <em>{content.hero.highlight}</em></h1><p>{content.hero.description}</p><b>{content.hero.primaryLabel}　↗</b><small>{content.hero.eligibilityNote}</small>{content.hero.image && <img src={imageSrc(content.hero.image)} alt="Draft hero preview" />}</section>
    <section><small>FEATURES</small><div className="website-preview-cards">{content.features.filter((item) => item.visible).map((item) => <article key={item.id}><b>{item.title}</b><p>{item.description}</p></article>)}</div></section>
    <section><small>HOW IT WORKS · PROCESSING FEE KSh {fee}</small>{content.steps.filter((item) => item.visible).map((item) => <p key={item.id}><b>{item.title}</b> — {item.description}</p>)}</section>
    <section><small>FAQ PREVIEW</small>{content.faqs.filter((item) => item.visible).map((item) => <details key={item.id}><summary>{item.question}</summary><p>{item.answer}</p></details>)}</section>
  </div>;

  if (preview) {
    return <main className="dashboard-page website-admin-page">
      <header className="dashboard-top"><Link className="wordmark" href="/admin"><span className="brand-mark">L+</span> loanplus <span className="admin-tag">ADMIN</span></Link><button className="quiet-button" type="button" onClick={() => setPreview(false)}>Back to editor</button></header>
      <section className="dashboard-welcome"><p className="eyebrow">PRIVATE DRAFT PREVIEW</p><h1>Review before publishing.</h1><p>This preview is visible only in your authenticated Admin session. Public visitors continue to see the published version.</p></section>
      {contentPreview}
    </main>;
  }

  return <main className="dashboard-page website-admin-page">
    <header className="dashboard-top"><Link className="wordmark" href="/admin"><span className="brand-mark">L+</span> loanplus <span className="admin-tag">ADMIN</span></Link><Link className="quiet-button" href="/admin">Administration</Link></header>
    <section className="dashboard-welcome"><p className="eyebrow">WEBSITE MANAGEMENT</p><h1>Website &amp; Landing Page.</h1><p>Save edits as a private draft, preview your changes, then explicitly publish them. The live site remains unchanged until publication.</p></section>
    <section className="website-publication-status">
      <div><span>Live version</span><b>{published ? `v${published.version}` : 'Default website content'}</b><small>{published?.publishedAt ? `Published ${new Date(published.publishedAt).toLocaleString('en-KE')} · ${published.publishedBy ?? 'Administrator'}` : 'No content version has been published yet.'}</small></div>
      <div><span>Draft version</span><b>{version ? `v${version}${dirty ? ' · unsaved edits' : ''}` : dirty ? 'New draft · unsaved edits' : 'No saved draft'}</b><small>{dirty ? 'Save your changes before leaving this page.' : 'Draft content is private to administrators.'}</small></div>
      <div className="website-fee-status"><span>Authoritative loan processing fee</span><b>KSh {fee.toLocaleString('en-KE')}</b><small>Read-only · set by the existing payment workflow</small></div>
    </section>
    {error && <p className="admin-inline-error" role="alert">{error}</p>}
    {notice && <p className="admin-inline-notice" role="status">{notice}</p>}
    <form className="website-editor" onSubmit={(event) => void submitSave(event)}>
      <fieldset disabled={busy}>
        <legend>Branding</legend>
        <div className="website-editor-grid">
          <label>Website display name<input value={content.branding.name} maxLength={60} required onChange={(event) => update('branding', { name: event.target.value })} /></label>
          <label>Tagline<input value={content.branding.tagline} maxLength={100} required onChange={(event) => update('branding', { tagline: event.target.value })} /></label>
          <label>Primary color<input type="color" value={content.branding.primaryColor} onChange={(event) => update('branding', { primaryColor: event.target.value })} /></label>
          <label>Accent color<input type="color" value={content.branding.accentColor} onChange={(event) => update('branding', { accentColor: event.target.value })} /></label>
          <label>Logo image<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void uploadImage(event, 'logo')} /><small>PNG, JPEG or WebP · max 5 MB</small>{content.branding.logo && <img className="website-image-preview website-logo-preview" src={imageSrc(content.branding.logo)} alt="Current logo preview" />}</label>
          <label>Footer brand note<input value={content.footer.note} maxLength={140} required onChange={(event) => update('footer', { note: event.target.value })} /></label>
        </div>
      </fieldset>

      <fieldset disabled={busy}>
        <legend>Hero content</legend>
        <div className="website-editor-grid">
          <label>Eyebrow<input value={content.hero.eyebrow} maxLength={60} required onChange={(event) => update('hero', { eyebrow: event.target.value })} /></label>
          <label>Headline<input value={content.hero.headline} maxLength={100} required onChange={(event) => update('hero', { headline: event.target.value })} /></label>
          <label>Highlighted phrase<input value={content.hero.highlight} maxLength={70} required onChange={(event) => update('hero', { highlight: event.target.value })} /></label>
          <label>Supporting text<textarea value={content.hero.description} maxLength={400} required onChange={(event) => update('hero', { description: event.target.value })} /></label>
          <label>Primary button label<input value={content.hero.primaryLabel} maxLength={40} required onChange={(event) => update('hero', { primaryLabel: event.target.value })} /></label>
          <label>Primary destination<select value={content.hero.primaryHref} onChange={(event) => update('hero', { primaryHref: event.target.value })}><option value="/register">Create account</option><option value="/login">Log in</option></select></label>
          <label>Secondary button label<input value={content.hero.secondaryLabel} maxLength={40} required onChange={(event) => update('hero', { secondaryLabel: event.target.value })} /></label>
          <label>Secondary destination<select value={content.hero.secondaryHref} onChange={(event) => update('hero', { secondaryHref: event.target.value })}><option value="#how-it-works">How it works</option><option value="#features">Features</option><option value="#faqs">FAQs</option><option value="/terms">Terms</option></select></label>
          <label>Eligibility and currency note<input value={content.hero.eligibilityNote} maxLength={120} required onChange={(event) => update('hero', { eligibilityNote: event.target.value })} /><small>Do not imply unsupported eligibility or loan terms.</small></label>
          <label>Hero image<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void uploadImage(event, 'hero')} /><small>PNG, JPEG or WebP · max 5 MB</small>{content.hero.image && <img className="website-image-preview" src={imageSrc(content.hero.image)} alt="Current hero image preview" />}</label>
        </div>
      </fieldset>

      <fieldset disabled={busy}>
        <legend>Public navigation</legend>
        <p className="settings-copy">Only approved public routes and HTTPS destinations can be saved. Customer, Admin and privileged routes are blocked.</p>
        {content.navigation.map((item, index) => <div className="website-repeat-row" key={item.id}>
          <label>Label<input value={item.label} maxLength={30} required onChange={(event) => setArray('navigation', content.navigation.map((entry, current) => current === index ? { ...entry, label: event.target.value } : entry))} /></label>
          <label>Approved destination<input value={item.href} maxLength={500} required placeholder="/terms or https://example.com" onChange={(event) => setArray('navigation', content.navigation.map((entry, current) => current === index ? { ...entry, href: event.target.value } : entry))} /></label>
          <label className="website-toggle"><input type="checkbox" checked={item.visible} onChange={(event) => setArray('navigation', content.navigation.map((entry, current) => current === index ? { ...entry, visible: event.target.checked } : entry))} /> Visible</label>
          <div className="website-row-actions"><button type="button" aria-label={`Move ${item.label} up`} onClick={() => setArray('navigation', reorder(content.navigation, index, -1))}>↑</button><button type="button" aria-label={`Move ${item.label} down`} onClick={() => setArray('navigation', reorder(content.navigation, index, 1))}>↓</button><button type="button" onClick={() => setArray('navigation', content.navigation.filter((_, current) => current !== index))}>Remove</button></div>
        </div>)}
        <button className="quiet-button" type="button" disabled={content.navigation.length >= 8} onClick={() => setArray('navigation', [...content.navigation, { id: `nav-${crypto.randomUUID()}`, label: 'New link', href: '#features', visible: true }])}>Add navigation link</button>
      </fieldset>

      <fieldset disabled={busy}>
        <legend>Benefits and feature cards</legend>
        {content.features.map((feature, index) => <div className="website-repeat-row" key={feature.id}>
          <label>Title<input value={feature.title} maxLength={60} required onChange={(event) => setArray('features', content.features.map((entry, current) => current === index ? { ...entry, title: event.target.value } : entry))} /></label>
          <label>Description<textarea value={feature.description} maxLength={240} required onChange={(event) => setArray('features', content.features.map((entry, current) => current === index ? { ...entry, description: event.target.value } : entry))} /></label>
          <label>Icon<select value={feature.icon} onChange={(event) => setArray('features', content.features.map((entry, current) => current === index ? { ...entry, icon: event.target.value } : entry))}>{allowedIcons.map((icon) => <option key={icon}>{icon}</option>)}</select></label>
          <label className="website-toggle"><input type="checkbox" checked={feature.visible} onChange={(event) => setArray('features', content.features.map((entry, current) => current === index ? { ...entry, visible: event.target.checked } : entry))} /> Published</label>
          <div className="website-row-actions"><button type="button" aria-label={`Move ${feature.title} up`} onClick={() => setArray('features', reorder(content.features, index, -1))}>↑</button><button type="button" aria-label={`Move ${feature.title} down`} onClick={() => setArray('features', reorder(content.features, index, 1))}>↓</button><button type="button" onClick={() => setArray('features', content.features.filter((_, current) => current !== index))}>Remove</button></div>
        </div>)}
        <button className="quiet-button" type="button" disabled={content.features.length >= 12} onClick={() => setArray('features', [...content.features, { id: `feature-${crypto.randomUUID()}`, title: 'New feature', description: 'Describe a supported LoanPlus feature.', icon: '✓', visible: false }])}>Add feature</button>
      </fieldset>

      <fieldset disabled={busy}>
        <legend>How LoanPlus works</legend>
        <p className="settings-copy">The six required customer journey and payment-confirmation steps are locked to backend behavior. You may reorder them; fee and approval disclosures cannot be hidden or edited.</p>
        {content.steps.map((step, index) => <div className="website-repeat-row" key={step.id}>
          <label>Step title<input value={step.title} readOnly={coreSteps.has(step.id)} maxLength={60} required onChange={(event) => setArray('steps', content.steps.map((entry, current) => current === index ? { ...entry, title: event.target.value } : entry))} /></label>
          <label>Explanation<textarea value={step.description} readOnly={coreSteps.has(step.id)} maxLength={240} required onChange={(event) => setArray('steps', content.steps.map((entry, current) => current === index ? { ...entry, description: event.target.value } : entry))} /></label>
          <label>Icon<select value={step.icon} disabled={coreSteps.has(step.id)} onChange={(event) => setArray('steps', content.steps.map((entry, current) => current === index ? { ...entry, icon: event.target.value } : entry))}>{allowedIcons.map((icon) => <option key={icon}>{icon}</option>)}</select></label>
          <label className="website-toggle"><input type="checkbox" checked={step.visible} disabled={coreSteps.has(step.id)} onChange={(event) => setArray('steps', content.steps.map((entry, current) => current === index ? { ...entry, visible: event.target.checked } : entry))} /> Visible</label>
          <div className="website-row-actions"><button type="button" aria-label={`Move ${step.title} up`} onClick={() => setArray('steps', reorder(content.steps, index, -1))}>↑</button><button type="button" aria-label={`Move ${step.title} down`} onClick={() => setArray('steps', reorder(content.steps, index, 1))}>↓</button></div>
        </div>)}
      </fieldset>

      <fieldset disabled={busy}>
        <legend>Frequently asked questions</legend>
        <p className="settings-copy">The required processing-fee and no-guaranteed-approval FAQ is locked and always published.</p>
        {content.faqs.map((faq, index) => <div className="website-repeat-row" key={faq.id}>
          <label>Question<input value={faq.question} readOnly={faq.id === 'fee'} maxLength={160} required onChange={(event) => setArray('faqs', content.faqs.map((entry, current) => current === index ? { ...entry, question: event.target.value } : entry))} /></label>
          <label>Answer<textarea value={faq.answer} readOnly={faq.id === 'fee'} maxLength={600} required onChange={(event) => setArray('faqs', content.faqs.map((entry, current) => current === index ? { ...entry, answer: event.target.value } : entry))} /></label>
          <label className="website-toggle"><input type="checkbox" checked={faq.visible} disabled={faq.id === 'fee'} onChange={(event) => setArray('faqs', content.faqs.map((entry, current) => current === index ? { ...entry, visible: event.target.checked } : entry))} /> Published</label>
          <div className="website-row-actions"><button type="button" aria-label={`Move ${faq.question} up`} onClick={() => setArray('faqs', reorder(content.faqs, index, -1))}>↑</button><button type="button" aria-label={`Move ${faq.question} down`} onClick={() => setArray('faqs', reorder(content.faqs, index, 1))}>↓</button>{faq.id !== 'fee' && <button type="button" onClick={() => setArray('faqs', content.faqs.filter((_, current) => current !== index))}>Remove</button>}</div>
        </div>)}
        <button className="quiet-button" type="button" disabled={content.faqs.length >= 20} onClick={() => setArray('faqs', [...content.faqs, { id: `faq-${crypto.randomUUID()}`, question: '', answer: '', visible: false }])}>Add FAQ</button>
      </fieldset>

      <fieldset disabled={busy}>
        <legend>Footer and SEO</legend>
        <div className="website-editor-grid">
          <label>Privacy link label<input value={content.footer.privacyLabel} maxLength={30} required onChange={(event) => update('footer', { privacyLabel: event.target.value })} /></label>
          <label>Terms link label<input value={content.footer.termsLabel} maxLength={30} required onChange={(event) => update('footer', { termsLabel: event.target.value })} /></label>
          <label>Page title<input value={content.seo.title} maxLength={70} required onChange={(event) => update('seo', { title: event.target.value })} /></label>
          <label>Meta description<textarea value={content.seo.description} maxLength={160} required onChange={(event) => update('seo', { description: event.target.value })} /></label>
          <label>Social-sharing title<input value={content.seo.socialTitle} maxLength={70} required onChange={(event) => update('seo', { socialTitle: event.target.value })} /></label>
          <label>Social-sharing description<textarea value={content.seo.socialDescription} maxLength={200} required onChange={(event) => update('seo', { socialDescription: event.target.value })} /></label>
          <label>Social-sharing image<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void uploadImage(event, 'social')} /><small>PNG, JPEG or WebP · max 5 MB</small>{content.seo.socialImage && <img className="website-image-preview" src={imageSrc(content.seo.socialImage)} alt="Current social-sharing image preview" />}</label>
        </div>
      </fieldset>
      <div className="website-actions">
        <button className="button" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save draft'}</button>
        <button className="quiet-button" type="button" disabled={busy} onClick={() => setPreview(true)}>Preview draft</button>
        <button className="button website-publish-button" type="button" disabled={busy || (!dirty && version === 0)} onClick={() => void publish()}>{busy ? 'Working…' : 'Publish changes'}</button>
        <button className="quiet-button website-discard-button" type="button" disabled={busy || (!dirty && version === 0)} onClick={() => void discardDraft()}>Discard draft</button>
      </div>
    </form>
    {history.length > 0 && <section className="website-history"><div className="admin-workspace-heading"><div><p className="eyebrow">PUBLICATION HISTORY</p><h2>Previous versions</h2></div></div>{history.map((revision) => <article key={revision.version}><b>Version {revision.version} · {revision.status.toLowerCase()}</b><span>Created {new Date(revision.createdAt).toLocaleString('en-KE')} by {revision.createdBy}</span>{revision.publishedAt && <span>Published {new Date(revision.publishedAt).toLocaleString('en-KE')} by {revision.publishedBy ?? 'Administrator'}</span>}</article>)}</section>}
    <div className="website-hidden-preview" aria-hidden="true">{contentPreview}</div>
  </main>;
}
