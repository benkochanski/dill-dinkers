/**
 * Cloudflare Worker — Dill Dinkers Sandbox front door.
 *
 * Serves two paths on dilldinkersct.com (or whatever host you point at it):
 *
 *   /sandbox            → 302 redirect to the Apps Script /exec URL.
 *                         Cleanest URL for sharing + DUPR review submission.
 *                         (Browser will land on googleusercontent.com after
 *                         the redirect resolves — that's Apps Script's iframe
 *                         hosting, nothing we can hide.)
 *
 *   /sandbox/webhook    → DUPR rating webhook. Responds 200 OK to the GET
 *                         handshake (Apps Script can't, since it always 302s)
 *                         and forwards POST events to Apps Script's doPost.
 *
 *   anything else       → 404.
 *
 * Cloudflare setup:
 *   1. Deploy this Worker (Workers & Pages → Create).
 *   2. Add a Route on your zone:
 *        dilldinkersct.com/sandbox*   → this Worker
 *      (the `*` matches /sandbox and /sandbox/webhook both).
 *   3. Test:
 *        curl -I https://dilldinkersct.com/sandbox          → 302
 *        curl    https://dilldinkersct.com/sandbox/webhook  → {"ok":true,...}
 */

// EDIT ME: paste the Apps Script /exec URL.
const APPS_SCRIPT_EXEC = 'https://script.google.com/macros/s/AKfycbz4srPzTi8id26-Rmz-Hd8702RWCAYCCTKtVCOaSuoC6WAFMa4nIhnDH11MnuEqbKzT/exec';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');  // strip trailing slash
    const method = request.method.toUpperCase();

    // --- Route: /sandbox/webhook (DUPR rating webhook) ---
    if (path === '/sandbox/webhook') {
      // Handshake — DUPR uses GET to verify reachability before storing the URL.
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
        return new Response(
          JSON.stringify({ ok: true, ready: true, proxy: 'dilldinkers-sandbox' }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      // Forward POST (rating event) to Apps Script's doPost.
      let body = '';
      try { body = await request.text(); } catch (e) { body = ''; }
      const upstream = await fetch(APPS_SCRIPT_EXEC, {
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

    // --- Route: /sandbox (UI entry) ---
    if (path === '/sandbox' || path === '/sandbox/') {
      // Preserve any query string the user came in with (e.g. ?page=register).
      const target = APPS_SCRIPT_EXEC + (url.search || '');
      return Response.redirect(target, 302);
    }

    // --- Anything else under our route ---
    return new Response('Not found', { status: 404 });
  },
};
