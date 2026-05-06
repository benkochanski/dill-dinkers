# Dill Dinkers Leagues — Public Site

Single static HTML page deployed to Cloudflare Workers (assets-only).
Pulls live data from the Apps Script JSON endpoint at `?page=json&action=...`.

```
public-site/
├── index.html      ← whole app (HTML + CSS + JS, ~700 lines)
├── wrangler.jsonc  ← assets-only config
└── README.md
```

No build step. No dependencies. The Apps Script `/exec` URL is hardcoded
near the top of `index.html` (search for `API_BASE`).

## Local preview

```bash
cd public-site
python3 -m http.server 8080   # or any static file server
# open http://localhost:8080
```

## Cloudflare deploy

In Cloudflare → Workers & Pages → `dill-dinkers-leagues-manager` → Settings → Build:

- **Build command**: (leave blank)
- **Deploy command**: `cd public-site && npx wrangler deploy`
- **Root directory**: `/`

That's it. `wrangler deploy` reads `public-site/wrangler.jsonc` and uploads
the directory as static assets.

## Custom domain

Add `leagues.dilldinkersct.com` under Workers & Pages → Settings → Domains
and set up the CNAME at your DNS registrar.
