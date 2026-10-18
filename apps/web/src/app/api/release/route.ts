import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const noStoreHeaders = { 'Cache-Control': 'no-store, max-age=0' };

export function GET() {
  const configuredRelease = process.env.APP_RELEASE_SHA;
  const vercelRelease = process.env.VERCEL_GIT_COMMIT_SHA;
  const candidate = [
    { releaseId: configuredRelease, source: 'configured' },
    { releaseId: vercelRelease, source: 'vercel' },
  ].find((release) => release.releaseId && /^[a-f0-9]{7,40}$/i.test(release.releaseId));
  if (!candidate) {
    return NextResponse.json({ releaseId: 'unknown', source: 'unknown' }, { headers: noStoreHeaders });
  }
  return NextResponse.json(candidate, { headers: noStoreHeaders });
}