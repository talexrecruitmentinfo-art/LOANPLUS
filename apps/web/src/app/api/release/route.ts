import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const noStoreHeaders = { 'Cache-Control': 'no-store, max-age=0' };

export function GET() {
  const configuredRelease = process.env.APP_RELEASE_SHA;
  const vercelRelease = process.env.VERCEL_GIT_COMMIT_SHA;
  const candidate = configuredRelease ?? vercelRelease;
  if (!candidate || !/^[a-f0-9]{7,40}$/i.test(candidate)) {
    return NextResponse.json({ releaseId: 'unknown', source: 'unknown' }, { headers: noStoreHeaders });
  }
  return NextResponse.json({
    releaseId: candidate,
    source: configuredRelease ? 'configured' : 'vercel',
  }, { headers: noStoreHeaders });
}