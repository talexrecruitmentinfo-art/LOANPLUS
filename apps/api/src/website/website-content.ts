import { BadRequestException } from '@nestjs/common';

export interface WebsiteContent {
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

export const DEFAULT_WEBSITE_CONTENT: WebsiteContent = {
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

const requiredSteps = DEFAULT_WEBSITE_CONTENT.steps;
const requiredFeeFaq = DEFAULT_WEBSITE_CONTENT.faqs[0];
const safeInternalHrefs = new Set([
  '/register', '/login', '/terms', '/privacy',
  '#features', '#how-it-works', '#faqs', '#processing-fee',
]);
const safeIcons = new Set(['↗', 'KSh', '✓', '◎', '?', '01', '02', '03', '04', '05', '06']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, max: number, min = 1): string {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) {
    throw new BadRequestException(`${field} must be ${min} to ${max} characters.`);
  }
  return value.trim();
}

function safeHref(value: unknown, field: string): string {
  const href = requiredString(value, field, 500);
  if (safeInternalHrefs.has(href)) return href;
  if (href.startsWith('https://')) {
    try {
      const url = new URL(href);
      if (url.protocol === 'https:' && !url.username && !url.password) return url.toString();
    } catch {
      // Validation error is reported below.
    }
  }
  throw new BadRequestException(`${field} must use an approved internal destination or an HTTPS URL.`);
}

function safeAsset(value: unknown, field: string): string {
  if (value === '') return '';
  const asset = requiredString(value, field, 220);
  const approved = /^\/api\/v1\/platform\/website\/assets\/[a-f0-9-]{36}\.(png|jpg|webp)$/i.test(asset) ||
    /^\/icons\/loanplus-(192|512)\.svg$/.test(asset);
  if (!approved) throw new BadRequestException(`${field} must reference an approved LoanPlus image asset.`);
  return asset;
}

function collection<T>(
  value: unknown,
  field: string,
  max: number,
  parse: (item: unknown, index: number) => T,
): T[] {
  if (!Array.isArray(value) || value.length > max) throw new BadRequestException(`${field} must contain at most ${max} entries.`);
  return value.map(parse);
}

function visible(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new BadRequestException(`${field} must be true or false.`);
  return value;
}

function idFor(value: unknown, field: string): string {
  const id = requiredString(value, field, 40);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new BadRequestException(`${field} contains unsupported characters.`);
  return id;
}

export function validateWebsiteContent(input: unknown): WebsiteContent {
  if (!isRecord(input)) throw new BadRequestException('Website content must be an object.');
  const { branding, hero, footer, seo } = input;
  if (!isRecord(branding) || !isRecord(hero) || !isRecord(footer) || !isRecord(seo)) {
    throw new BadRequestException('Website branding, hero, footer and SEO sections are required.');
  }
  const color = (value: unknown, field: string) => {
    const result = requiredString(value, field, 7);
    if (!/^#[0-9a-f]{6}$/i.test(result)) throw new BadRequestException(`${field} must be a six-digit hex color.`);
    return result;
  };
  const result: WebsiteContent = {
    branding: {
      name: requiredString(branding.name, 'Brand name', 60),
      tagline: requiredString(branding.tagline, 'Brand tagline', 100),
      primaryColor: color(branding.primaryColor, 'Primary color'),
      accentColor: color(branding.accentColor, 'Accent color'),
      logo: safeAsset(branding.logo, 'Logo'),
    },
    hero: {
      eyebrow: requiredString(hero.eyebrow, 'Hero eyebrow', 60),
      headline: requiredString(hero.headline, 'Hero headline', 100),
      highlight: requiredString(hero.highlight, 'Hero highlight', 70),
      description: requiredString(hero.description, 'Hero description', 400),
      primaryLabel: requiredString(hero.primaryLabel, 'Primary CTA label', 40),
      primaryHref: safeHref(hero.primaryHref, 'Primary CTA destination'),
      secondaryLabel: requiredString(hero.secondaryLabel, 'Secondary CTA label', 40),
      secondaryHref: safeHref(hero.secondaryHref, 'Secondary CTA destination'),
      eligibilityNote: requiredString(hero.eligibilityNote, 'Eligibility note', 120),
      image: safeAsset(hero.image, 'Hero image'),
    },
    navigation: collection(input.navigation, 'Navigation', 8, (item, index) => {
      if (!isRecord(item)) throw new BadRequestException(`Navigation item ${index + 1} is invalid.`);
      return {
        id: idFor(item.id, 'Navigation identifier'),
        label: requiredString(item.label, 'Navigation label', 30),
        href: safeHref(item.href, 'Navigation destination'),
        visible: visible(item.visible, 'Navigation visibility'),
      };
    }),
    features: collection(input.features, 'Features', 12, (item, index) => {
      if (!isRecord(item)) throw new BadRequestException(`Feature ${index + 1} is invalid.`);
      if (typeof item.icon !== 'string' || !safeIcons.has(item.icon)) throw new BadRequestException('Feature icon is not supported.');
      return { id: idFor(item.id, 'Feature identifier'), title: requiredString(item.title, 'Feature title', 60), description: requiredString(item.description, 'Feature description', 240), icon: item.icon, visible: visible(item.visible, 'Feature visibility') };
    }),
    steps: collection(input.steps, 'Steps', 10, (item, index) => {
      if (!isRecord(item)) throw new BadRequestException(`Step ${index + 1} is invalid.`);
      if (typeof item.icon !== 'string' || !safeIcons.has(item.icon)) throw new BadRequestException('Step icon is not supported.');
      return { id: idFor(item.id, 'Step identifier'), title: requiredString(item.title, 'Step title', 60), description: requiredString(item.description, 'Step description', 240), icon: item.icon, visible: visible(item.visible, 'Step visibility') };
    }),
    faqs: collection(input.faqs, 'FAQs', 20, (item, index) => {
      if (!isRecord(item)) throw new BadRequestException(`FAQ ${index + 1} is invalid.`);
      return { id: idFor(item.id, 'FAQ identifier'), question: requiredString(item.question, 'FAQ question', 160), answer: requiredString(item.answer, 'FAQ answer', 600), visible: visible(item.visible, 'FAQ visibility') };
    }),
    footer: {
      note: requiredString(footer.note, 'Footer note', 140),
      privacyLabel: requiredString(footer.privacyLabel, 'Privacy link label', 30),
      termsLabel: requiredString(footer.termsLabel, 'Terms link label', 30),
    },
    seo: {
      title: requiredString(seo.title, 'Page title', 70),
      description: requiredString(seo.description, 'Meta description', 160),
      socialTitle: requiredString(seo.socialTitle, 'Social title', 70),
      socialDescription: requiredString(seo.socialDescription, 'Social description', 200),
      socialImage: safeAsset(seo.socialImage, 'Social image'),
    },
  };
  for (const required of requiredSteps) {
    const step = result.steps.find((candidate) => candidate.id === required.id);
    if (!step || !step.visible || step.title !== required.title || step.description !== required.description || step.icon !== required.icon) {
      throw new BadRequestException('Required loan application steps and payment disclosures cannot be removed or changed.');
    }
  }
  const feeFaq = result.faqs.find((faq) => faq.id === requiredFeeFaq.id);
  if (!feeFaq || !feeFaq.visible || feeFaq.question !== requiredFeeFaq.question || feeFaq.answer !== requiredFeeFaq.answer) {
    throw new BadRequestException('The processing-fee FAQ and approval disclaimer are required and cannot be changed.');
  }
  return result;
}
