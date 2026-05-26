/**
 * Worker entry for dilldinkersct.com (leagues SPA + sandbox routing).
 *
 * Routing by host:
 *
 *   sandbox.dilldinkersct.com/        → 302 to sandbox Apps Script /exec
 *   sandbox.dilldinkersct.com/webhook → DUPR webhook (200 to GET handshake,
 *                                       forward POST events to doPost)
 *   sandbox.dilldinkersct.com/*       → 404
 *
 *   dilldinkersct.com/sandbox             → 302 to sandbox /exec  (legacy alias)
 *   dilldinkersct.com/sandbox/webhook     → DUPR webhook        (legacy alias)
 *   dilldinkersct.com/*                   → static leagues SPA
 *
 * The legacy /sandbox* paths are kept so any link or webhook registration
 * already pointing at them keeps working during cutover.
 *
 * Files starting with `_` are excluded from Cloudflare's static-assets
 * serving; this file is named `sandbox-router.js` so wrangler doesn't trigger
 * its Pages-mode safety check on `_worker.js`.
 */

const SANDBOX_EXEC = 'https://script.google.com/macros/s/AKfycbz4srPzTi8id26-Rmz-Hd8702RWCAYCCTKtVCOaSuoC6WAFMa4nIhnDH11MnuEqbKzT/exec';

// 200 OK JSON for DUPR's GET/HEAD/OPTIONS handshake.
function handshakeResponse() {
  return new Response(
    JSON.stringify({ ok: true, ready: true, proxy: 'dilldinkers-sandbox' }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

// Forward POST body to Apps Script doPost; return its response.
async function forwardWebhook(request, method) {
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/, '');
    const method = request.method.toUpperCase();
    const isSandboxHost = host === 'sandbox.dilldinkersct.com';

    // ── Host: sandbox.dilldinkersct.com ──
    if (isSandboxHost) {
      if (path === '/webhook') {
        if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return handshakeResponse();
        return forwardWebhook(request, method);
      }
      if (path === '' || path === '/') {
        return Response.redirect(SANDBOX_EXEC + (url.search || ''), 302);
      }
      // Anything else under the sandbox host is unknown.
      return new Response('Not found', { status: 404 });
    }

    // ── Host: dilldinkersct.com (or www) — legacy /sandbox* aliases ──
    if (path === '/sandbox/webhook') {
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return handshakeResponse();
      return forwardWebhook(request, method);
    }
    if (path === '/sandbox' || path === '/sandbox/') {
      return Response.redirect(SANDBOX_EXEC + (url.search || ''), 302);
    }
    if (path.startsWith('/sandbox/')) {
      return new Response('Not found', { status: 404 });
    }

    // ── Everything else → leagues static SPA ──
    return env.ASSETS.fetch(request);
  },
};
