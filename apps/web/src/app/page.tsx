import type { Metadata } from 'next';
import PublicHomePage from '@/components/public-homepage';
import { resolveApiAsset } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const fallback: Metadata = {
    title: 'LoanPlus | Clearer borrowing, built around you',
    description: 'Explore responsible borrowing options and manage your LoanPlus account.',
    openGraph: {
      title: 'LoanPlus',
      description: 'Explore straightforward loan options with clear terms.',
      type: 'website',
      images: ['/icons/loanplus-512.png'],
    },
    twitter: {
      card: 'summary_large_image',
      title: 'LoanPlus',
      description: 'Explore straightforward loan options with clear terms.',
      images: ['/icons/loanplus-512.png'],
    },
  };
  try {
    const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';
    const response = await fetch(`${apiBase}/platform/website`, { cache: 'no-store' });
    if (!response.ok) return fallback;
    const payload = await response.json() as { data?: { content?: { seo?: { title?: unknown; description?: unknown; socialTitle?: unknown; socialDescription?: unknown; socialImage?: unknown } } } };
    const seo = payload.data?.content?.seo;
    if (!seo || typeof seo.title !== 'string' || typeof seo.description !== 'string' ||
      typeof seo.socialTitle !== 'string' || typeof seo.socialDescription !== 'string') return fallback;
    const images = typeof seo.socialImage === 'string' && seo.socialImage
      ? [resolveApiAsset(seo.socialImage)]
      : ['/icons/loanplus-512.png'];
    return {
      title: seo.title,
      description: seo.description,
      openGraph: { title: seo.socialTitle, description: seo.socialDescription, type: 'website', images },
      twitter: { card: 'summary_large_image', title: seo.socialTitle, description: seo.socialDescription, images },
    };
  } catch {
    return fallback;
  }
}

export default function HomePage() {
  return <PublicHomePage />;
}
