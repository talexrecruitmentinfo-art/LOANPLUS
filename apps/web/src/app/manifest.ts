import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'LoanPlus',
    short_name: 'LoanPlus',
    description: 'Manage your LoanPlus account, wallet and borrowing activity.',
    start_url: '/dashboard',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#f5f5ed',
    theme_color: '#1d503b',
    icons: [
      { src: '/icons/loanplus-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/loanplus-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/loanplus-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/loanplus-192.svg', sizes: '192x192', type: 'image/svg+xml', purpose: 'any' },
    ],
  };
}