import { NextResponse } from 'next/server';

/**
 * Root proxy — adds CORS headers so browsers can call the API.
 *
 * (Next 16 renamed the file convention from `middleware` to `proxy`. The
 * function and config exports behave identically — they run at the edge
 * before any route, can short-circuit, and can rewrite responses.)
 *
 * Why this is needed:
 *   The mobile app talks to this API natively, where browser CORS does
 *   not apply. The web app (poripurok-web) runs in a browser, so it
 *   needs an Access-Control-Allow-Origin header on every response and
 *   a 204 reply to the OPTIONS preflight that the browser sends before
 *   any POST with a custom header (X-Poripurok-Client-Key).
 *
 * What this is NOT:
 *   - Not an auth check. Per-route validateClientKey()/authenticateRequest()
 *     calls remain the source of truth for authorization. CORS is purely
 *     about telling the browser which origins are allowed to make
 *     cross-origin requests.
 *   - Not visible to the mobile app. Mobile clients don't send an Origin
 *     header, so this proxy passes them through untouched.
 *
 * Origin allowlist:
 *   Hardcoded below. Match is exact (scheme + host + port). www and apex
 *   are different origins, so list both — DNS redirects don't help once
 *   a browser has already started a CORS check against the bare URL it
 *   was given. Add new origins here when a new web client ships and
 *   redeploy.
 */

const ALLOWED_ORIGINS = [
  // Production web domains — apex + www for each.
  'https://poripurok.com',
  'https://www.poripurok.com',
  'https://poripurok.ai',
  'https://www.poripurok.ai',
  'https://poripurok.io',
  'https://www.poripurok.io',
  // EC2 staging/dev box used for live testing during development.
  'http://177.71.193.157:3001',
  // Local development (browsers treat localhost and 127.0.0.1 as
  // different origins, so list both).
  'http://localhost:3001',
  'http://127.0.0.1:3001',
];

const ALLOWED_METHODS = 'GET, POST, PATCH, PUT, DELETE, OPTIONS';
const ALLOWED_HEADERS = 'Content-Type, Authorization, X-Poripurok-Client-Key';
// 24 hours — browsers cache the preflight result so subsequent calls
// from the same origin skip the OPTIONS round-trip.
const PREFLIGHT_MAX_AGE = '86400';

function applyCorsHeaders(headers, origin) {
  headers.set('Access-Control-Allow-Origin', origin);
  // Tell intermediaries the response varies by Origin so they don't
  // serve a cached response intended for a different origin.
  headers.set('Vary', 'Origin');
  headers.set('Access-Control-Allow-Methods', ALLOWED_METHODS);
  headers.set('Access-Control-Allow-Headers', ALLOWED_HEADERS);
  headers.set('Access-Control-Max-Age', PREFLIGHT_MAX_AGE);
}

export function proxy(request) {
  const origin = request.headers.get('origin');

  // No Origin header → not a browser CORS request (mobile app, curl,
  // server-to-server). Pass through unmodified — no CORS contract to
  // honor and adding headers would be noise.
  if (!origin) {
    return NextResponse.next();
  }

  const isAllowed = ALLOWED_ORIGINS.includes(origin);

  // Preflight: short-circuit BEFORE the route runs. Important — the
  // route would 401 because preflights don't carry the client-key
  // header, which is exactly the header the preflight is trying to ask
  // permission for.
  if (request.method === 'OPTIONS') {
    if (!isAllowed) {
      // Origin not on the allowlist. Reply 204 with no CORS headers; the
      // browser will block the follow-up request on its own.
      return new NextResponse(null, { status: 204 });
    }
    const response = new NextResponse(null, { status: 204 });
    applyCorsHeaders(response.headers, origin);
    return response;
  }

  // Actual request: let the route handle it. If the origin is allowed,
  // attach CORS headers to the eventual response.
  const response = NextResponse.next();
  if (isAllowed) {
    applyCorsHeaders(response.headers, origin);
  }
  return response;
}

// Limit to /api/* — the rest of the app (Next.js pages, static
// assets) doesn't need CORS handling.
export const config = {
  matcher: '/api/:path*',
};
