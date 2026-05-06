# Dill Dinkers Leagues — Public Site

Public-facing website at `leagues.dilldinkersct.com`. Pure SvelteKit SPA
deployed to Cloudflare Pages. Pulls live data from the Apps Script JSON
endpoint (`?page=json&action=...`) — no database, no backend of its own.

## Quick start

```bash
cd public-site
npm install
cp .env.example .env
# Edit .env, set PUBLIC_API_BASE to your Apps Script /exec URL
npm run dev
```

Open <http://localhost:5173>.

## Architecture

```
[Browser]
   │  fetch GET
   ▼
[Apps Script web app /exec?page=json&action=...]
   │  reads from
   ▼
[Master Google Sheet]
```

- The Apps Script side lives in the parent directory. The relevant code is
  `Public.js` (data shaping + access control) and the `?page=json` route in
  `Web.js`. No PII (emails, phones) is exposed.
- The frontend is a SvelteKit SPA built with `adapter-cloudflare` (fallback
  mode). All routes render client-side; no SSR.

## Routes

| Path                                        | Page                              |
|---------------------------------------------|-----------------------------------|
| `/`                                         | List of active leagues            |
| `/[league-slug]`                            | League standings                  |
| `/[league-slug]/schedule`                   | Full season schedule              |
| `/[league-slug]/results`                    | Completed games                   |
| `/[league-slug]/teams`                      | Team grid (partner only)          |
| `/[league-slug]/teams/[team_id]`            | Team detail (H2H, subs, etc.)     |

Slugs are derived from league `name` server-side (lowercase, dashes).

## Deploying to Cloudflare Pages

1. **Push this `public-site/` directory to its own repo** (or use a subdir
   in the existing repo — Cloudflare Pages supports `Root directory =
   public-site` in build settings).
2. **In Cloudflare Pages → Create project → Connect to Git**, select the
   repo. Build settings:
   - Framework preset: **SvelteKit**
   - Build command: `npm run build`
   - Build output directory: `.svelte-kit/cloudflare`
   - Root directory: `public-site` (if using a subdirectory)
3. **Environment variables** (Production + Preview):
   - `PUBLIC_API_BASE` = your Apps Script `/exec` URL
4. **Custom domain**: Pages → your project → Custom domains → Add
   `leagues.dilldinkersct.com`. Cloudflare will create the CNAME automatically
   if `dilldinkersct.com` is on Cloudflare DNS; otherwise add the CNAME at
   your registrar pointing at the Pages `*.pages.dev` URL.

## Apps Script deployment

The JSON endpoint must be exposed to anonymous users:

1. In the Apps Script editor: **Deploy → New deployment → Web app**
2. Execute as: **Me**
3. Who has access: **Anyone** (this is the key — it sets the CORS header)
4. Deploy → copy the `/exec` URL → paste into `PUBLIC_API_BASE`

After any backend change, re-deploy a new version (Manage deployments →
Edit → New version) so production picks it up. `/dev` URLs work only for
the script owner and CANNOT be used by the public site.
