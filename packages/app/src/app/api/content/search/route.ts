/**
 * Search Content API Route
 * GET /api/content/search
 * Returns search results with debouncing and caching.
 *
 * Ported from Flyx 2.0 — adapted for Flyx 3.0 monorepo.
 * - Replaced tmdbService with direct TMDB API calls.
 * - Rate limiter ported to simplified in-memory implementation.
 */

import { NextRequest, NextResponse } from 'next/server';
import { searchRateLimiter, getClientIP } from '@/lib/utils/api-rate-limiter';
import { readSearchParameters } from '@/lib/search/state';
import { searchCatalog } from '@/lib/search/catalog';
import { tmdbApi } from '@/lib/utils/tmdb-api';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    // Rate limiting (stricter for search to prevent abuse)
    const clientIP = getClientIP(request);
    const rateLimit = searchRateLimiter.checkLimit(clientIP);

    if (!rateLimit.allowed) {
      return NextResponse.json(
        {
          error: 'Too many requests',
          message: 'Search rate limit exceeded. Please try again later.',
          retryAfter: Math.ceil((rateLimit.resetAt - Date.now()) / 1000),
        },
        {
          status: 429,
          headers: {
            'X-RateLimit-Limit': '30',
            'X-RateLimit-Remaining': rateLimit.remaining.toString(),
            'X-RateLimit-Reset': rateLimit.resetAt.toString(),
            'Retry-After': Math.ceil(
              (rateLimit.resetAt - Date.now()) / 1000,
            ).toString(),
          },
        },
      );
    }

    const { searchParams } = new URL(request.url);
    const page = Number(searchParams.get('page') || '1');
    if (!Number.isInteger(page) || page < 1 || page > 500) {
      return NextResponse.json({ message: 'Page must be between 1 and 500' }, { status: 400 });
    }
    const parameters = readSearchParameters(searchParams);
    if (parameters.filters.contentType === 'anime') {
      return NextResponse.json({ message: 'Use anime search for anime titles' }, { status: 400 });
    }
    const category = searchParams.get('category');
    const result = category
      ? await tmdbApi.searchByCategory(category, parameters.filters.contentType, page).then((items) => ({ items, page, nextPage: items.length && page < 500 ? page + 1 : null }))
      : await searchCatalog(parameters, page, searchParams.get('excludeAnime') === 'true', request.signal);
    return NextResponse.json({
      success: true,
      data: result.items,
      count: result.items.length,
      query: parameters.query || category || parameters.filters.genres.join(','),
      page: result.page,
      nextPage: result.nextPage,
      hasMore: result.nextPage !== null,
    }, {
      headers: {
        'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=1200',
        'X-RateLimit-Limit': '30',
        'X-RateLimit-Remaining': rateLimit.remaining.toString(),
        'X-RateLimit-Reset': rateLimit.resetAt.toString(),
      },
    });
  } catch (error: any) {
    if (request.signal.aborted) return NextResponse.json({ message: 'Search cancelled' }, { status: 499 });
    console.error('Search API error:', error);

    if (error.code === 'MISSING_API_KEY') {
      return NextResponse.json(
        {
          error: 'Configuration error',
          message: 'Service is not properly configured',
        },
        { status: 500 },
      );
    }

    if (error.statusCode === 404) {
      return NextResponse.json(
        {
          success: true,
          data: [],
          count: 0,
          page: Number(new URL(request.url).searchParams.get('page')) || 1,
          nextPage: null,
          hasMore: false,
          message: 'No results found',
        },
        { status: 200 },
      );
    }

    return NextResponse.json(
      {
        error: 'Internal server error',
        message: 'Failed to perform search',
      },
      { status: 500 },
    );
  }
}
