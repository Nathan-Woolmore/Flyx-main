import { NextRequest, NextResponse } from 'next/server';
import { tmdbApi } from '@/lib/utils/tmdb-api';
import { contentRateLimiter, getClientIP } from '@/lib/utils/api-rate-limiter';

export const dynamic = 'force-dynamic';

// Same catalogue access policy as content/details. Provider credentials remain
// server-side; only the fixed TV-season resource can be requested.
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const id = params.get('id') ?? '';
  const raw = params.get('season');
  const season = Number(raw);
  if (!/^[1-9][0-9]{0,9}$/.test(id) || raw === null || !Number.isSafeInteger(season) || season < 0 || season > 1000)
    return NextResponse.json({ error: 'Invalid series or season' }, { status: 400 });
  if (!contentRateLimiter.checkLimit(getClientIP(request)).allowed)
    return NextResponse.json({ error: 'Catalogue rate limit reached' }, { status: 429 });
  try {
    const data = await tmdbApi.getSeasonDetails(id, season);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    return NextResponse.json({ error: status === 404 ? 'Season not found' : 'Season provider unavailable' }, { status: status === 404 ? 404 : status === 429 ? 429 : 502 });
  }
}
