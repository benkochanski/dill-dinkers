# Dill Dinkers Sandbox — Cloudflare Worker

One Worker serves two paths on `dilldinkersct.com`:

| Path | Purpose |
|---|---|
| `/sandbox` | Clean entry URL. 302-redirects to the Apps Script `/exec` URL so the share link and DUPR review submission look legit (not a raw `script.google.com` URL). |
| `/sandbox/webhook` | DUPR rating webhook receiver. Responds 200 to DUPR's GET handshake (which Apps Script can't) and forwards POST events to Apps Script's `doPost`. |

This solves the underlying Apps Script constraint: every `/exec` GET responds with a 302 (Apps Script wraps content in a sandboxed `googleusercontent.com` iframe). DUPR's webhook validator demands 200 OK to its GET handshake, so we need something that isn't Apps Script answering that.

## Deploy

### 1. Create the Worker

1. [Cloudflare dashboard](https://dash.cloudflare.com/) → Workers & Pages → Create → Worker.
2. Name it `dill-sandbox` (or whatever).
3. Click **Edit code**. Replace the default with the contents of `worker.js`.
4. Verify the `APPS_SCRIPT_EXEC` constant matches your current `/exec` URL.
5. **Save and Deploy**.

### 2. Add a Route on dilldinkersct.com

This is the part that wires `dilldinkersct.com/sandbox*` to the Worker. Requires the domain to be on Cloudflare DNS.

1. In Cloudflare dashboard → select `dilldinkersct.com` zone.
2. Workers Routes → Add Route.
3. Route: `dilldinkersct.com/sandbox*`
4. Worker: select the Worker you just created.
5. Save.

The `*` wildcard catches both `/sandbox` and `/sandbox/webhook`.

### 3. Verify

```bash
# UI redirect (should return 302 → Apps Script /exec)
curl -I https://dilldinkersct.com/sandbox

# Webhook handshake (should return 200 with JSON)
curl https://dilldinkersct.com/sandbox/webhook

# Webhook POST (forwarded to Apps Script doPost)
curl -X POST https://dilldinkersct.com/sandbox/webhook \
  -H 'content-type: application/json' \
  -d '{"event":"PING"}'
```

## Use it

- **Share with players for registration**: `https://dilldinkersct.com/sandbox?page=register`
- **Admin login**: `https://dilldinkersct.com/sandbox`
- **Webhook URL for DUPR registration**: `https://dilldinkersct.com/sandbox/webhook`

In the sandbox → DUPR info tab → paste `https://dilldinkersct.com/sandbox/webhook` into the Rating webhook field, click Save & register.

## What goes through the proxy

| Request | Worker behavior |
|---|---|
| `GET /sandbox` (browser) | 302 → Apps Script `/exec` (then to `googleusercontent.com` as normal) |
| `GET /sandbox/webhook` (DUPR handshake) | 200 OK answered locally |
| `POST /sandbox/webhook` (rating event) | Forwarded to Apps Script `doPost`, response returned |
| Anything else under `/sandbox*` | 404 |

## Cost

Free tier: 100k Worker requests/day. DUPR rating events are very low volume.

## Notes

- After the 302 from `/sandbox`, the user's URL bar will change to the Apps Script `script.google.com/...` URL. That's unavoidable — Apps Script serves all UI from `googleusercontent.com` via 302. We can't hide it without iframing (which breaks the app's own SSO iframe). The `dilldinkersct.com/sandbox` URL is the clean entry point; that's the value.
- For an even cleaner look, set up an iframe wrapper at `dilldinkersct.com/sandbox` that hosts the Apps Script app — but Apps Script forbids being framed by default, so this would require its own infra. Not recommended.
