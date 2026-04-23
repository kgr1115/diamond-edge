import { NextRequest, NextResponse } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

// Routes that require geo-blocking enforcement.
// Marketing pages, stats, and public history are intentionally excluded per geo-block-spec.md.
const GEO_PROTECTED_PREFIXES = ['/api/picks', '/api/bankroll', '/picks', '/bankroll'];

// ALLOW list sourced from GEO_ALLOW_STATES env var (comma-separated two-letter codes).
// In v1 this is baked into a Vercel env var; v1.1 will add DB-driven refresh.
function getAllowedStates(): Set<string> {
  const raw = process.env.GEO_ALLOW_STATES ?? '';
  if (!raw) return new Set();
  return new Set(raw.split(',').map((s) => s.trim().toUpperCase()));
}

function isGeoProtectedPath(pathname: string): boolean {
  return GEO_PROTECTED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function geoBlockedResponse(request: NextRequest): NextResponse {
  const isApiRoute = request.nextUrl.pathname.startsWith('/api/');
  if (isApiRoute) {
    return NextResponse.json(
      { error: { code: 'GEO_RESTRICTED', message: 'This service is not available in your location.' } },
      { status: 403 }
    );
  }
  // For page routes: redirect to a geo-gate page (frontend renders the copy)
  const geoGateUrl = request.nextUrl.clone();
  geoGateUrl.pathname = '/geo-blocked';
  return NextResponse.redirect(geoGateUrl);
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  // Always let Supabase Auth update the session cookie (required for SSR auth to work).
  // updateSession runs before geo-check so the session is always refreshed regardless
  // of whether the user is subsequently blocked.
  const sessionResponse = await updateSession(request);

  if (isGeoProtectedPath(pathname)) {
    // Vercel injects the region via the x-vercel-ip-country-region header in Edge Middleware.
    // NextRequest.geo was removed in Next.js 15; use the header directly.
    const region =
      (request.headers.get('x-vercel-ip-country-region') ?? '').toUpperCase() || null;
    const allowedStates = getAllowedStates();

    // Conflict resolution per geo-block-spec.md:
    // IP unknown + no declared state → block (conservative default)
    if (!region || !allowedStates.has(region)) {
      const blocked = geoBlockedResponse(request);
      // Propagate any Set-Cookie headers from the session update so auth state isn't lost
      sessionResponse.headers.forEach((value, key) => {
        if (key.toLowerCase() === 'set-cookie') {
          blocked.headers.append(key, value);
        }
      });
      blocked.headers.set('X-Geo-Blocked', 'true');
      return blocked;
    }

    // State is in ALLOW list — attach geo header so API routes can read it without
    // re-parsing geo on the server side
    sessionResponse.headers.set('X-Geo-State', region);
  }

  return sessionResponse;
}

export const config = {
  matcher: [
    // Run on all routes except static assets and Next.js internals
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
