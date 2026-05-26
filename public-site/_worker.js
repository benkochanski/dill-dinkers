/**
 * Worker entry for dilldinkersct.com.
 *
 * Handles two route groups by path:
 *
 *   /sandbox            → 302 redirect to the sandbox Apps Script /exec URL.
 *                         Clean entry URL for sharing + DUPR review.
 *   /sandbox/webhook    → DUPR rating webhook. Answers 200 OK to the GET
 *                         handshake (Apps Script can't, since /exec always
 *                         302s) and forwards POST events to Apps Script's
 *                         doPost.
 *   anything else       → falls through to the static-asset SPA (the
 *                         existing leagues UI at public-site/index.html).
 *
 * Files starting with `_` (including this one) are excluded from
 * Cloudflare's static-assets serving automatically.
 */

const SANDBOX_EXEC = 'https://script.google.com/macros/s/AKfycbz4srPzTi8id26-Rmz-Hd8702RWCAYCCTKtVCOaSuoC6WAFMa4nIhnDH11MnuEqbKzT/exec';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    const method = request.method.toUpperCase();

    // /sandbox/webhook — DUPR rating webhook receiver.
    if (path === '/sandbox/webhook') {
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
        return new Response(
          JSON.stringify({ ok: true, ready: true, proxy: 'dilldinkers-sandbox' }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      let body = '';
      try { body = await request.text(); } catch (e) { body = ''; }
      const upstream = await fetch(SANDBOX_EXEC, {
        method:  method,
        headers: { 'content-type': request.headers.get('content-type') || 'application/json' },
        body:    body,
        redirect: 'follow',
      });
      const respBody = await upstream.text();
      return new Response(respBody, {
        status:  upstream.status,
        headers: { 'content-type': upstream.headers.get('content-type') || 'application/json' },
      });
    }

    // /sandbox — UI entry. Preserve query string (e.g. ?page=register).
    if (path === '/sandbox' || path === '/sandbox/') {
      return Response.redirect(SANDBOX_EXEC + (url.search || ''), 302);
    }

    // Any other /sandbox/* path → 404 (don't fall through to the SPA, which
    // would mistakenly serve the leagues index.html).
    if (path.startsWith('/sandbox/')) {
      return new Response('Not found', { status: 404 });
    }

    // Everything else → existing static-asset SPA (the leagues UI).
    return env.ASSETS.fetch(request);
  },
};
