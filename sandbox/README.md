# Dill Dinkers — Sandbox

Standalone Apps Script project for testing the DUPR integration end-to-end before wiring it into the production league manager. Lives alongside (not inside) the prod codebase so a sandbox bug can't take down prod.

## What's inside

Four features, each isolated from production:

1. **Test admin login** — single email/password gate (no Google sign-in, no Roles sheet)
2. **DUPR player linking via OAuth SSO** — per-player share link, captures verified DUPR ID
3. **Score submit module** — operator picks four players + scores; saves a complete match row
4. **DUPR API push** — posts completed matches to DUPR's match-create endpoint; logs every attempt

## Setup

### 1. Create the backing Sheet
Create a new Google Sheet (any name). Copy its ID from the URL.

### 2. Create the Apps Script project
```bash
cd sandbox
# First-time only:
clasp create --type webapp --title "Dill Dinkers Sandbox"
# Then push files:
clasp push -f
```

Or, in the Apps Script editor: New project → paste this folder's contents.

Paste the new `scriptId` into `sandbox/.clasp.json` (the placeholder there says `PASTE_NEW_SCRIPT_ID_HERE`).

### 3. Set Script Properties
Open the Apps Script editor → ⚙ Project Settings → Script Properties → add:

| Key | Value | Notes |
|---|---|---|
| `SANDBOX_SHEET_ID` | Sheet ID from step 1 | Required. |
| `ADMIN_EMAIL` | Test admin email | Set via `setAdminPasswordToValue` instead — see below. |
| `ADMIN_PASSWORD_HASH` | (auto) | Set via `setAdminPasswordToValue`. |
| `DUPR_BASE_URL` | e.g. `https://uat.mydupr.com/api` | Required for DUPR push + OAuth. |
| `DUPR_CLIENT_ID` | OAuth client_id | From DUPR partner portal. |
| `DUPR_CLIENT_SECRET` | OAuth client_secret | From DUPR partner portal. |
| `DUPR_PARTNER_TOKEN` | Long-lived partner token | Used for match push if separate from OAuth. |

The two `set*ToValue` helpers in `Bootstrap.js` make this easier:

```javascript
// In Bootstrap.js — edit the literals, Run, then reset to ''.
function setAdminPasswordToValue() {
  const email = 'you@example.com';
  const password = 'pick-a-strong-one';
  // ...
}
function setDuprCredentialsToValue() {
  const base_url      = 'https://uat.mydupr.com/api';
  const client_id     = 'abc123';
  const client_secret = 'xyz';
  const partner_token = 'eyJhbGc...';
  // ...
}
```

Run each function from the editor's function dropdown. **Reset the literals to empty strings and save again** so secrets don't sit in version control.

### 4. Bootstrap the tabs
Function dropdown → `bootstrap` → Run. Creates 5 tabs:
- `Players` — roster; `dupr_id` is only written by the SSO flow
- `Games` — completed matches
- `DUPR_Push_Log` — every push attempt with full request/response
- `Admin_Sessions` — login tokens
- `Audit_Log` — append-only event log

Re-running is safe — only adds missing columns, never removes.

### 5. Deploy
Editor → Deploy → New deployment → Web app
- Execute as: **Me**
- Who has access: **Anyone**

Note the `/exec` URL — that's the sandbox URL you'll share.

### 6. Register the OAuth redirect URI with DUPR
Tell DUPR's partner team to add this URL to your OAuth app's allowed redirects:

```
<your /exec URL>?page=oauth_cb
```

(Run `status()` from the editor to see the deployed URL.)

## Using it

### Admin
1. Open `<your /exec URL>` → land on Login → sign in with the test admin email/password.
2. **Home** = add players, see DUPR status, copy each player's per-player link URL.
3. **Operator** = enter scores; save & push to DUPR in one click.

### Players linking DUPR
- Admin shares the URL `?page=link&pid=<player_id>` with the player (one click in the Home view).
- Player clicks → "Link my DUPR account" button → DUPR SSO → callback writes `dupr_id` to their Players row with `link_source = 'sso'`.
- No manual DUPR ID entry anywhere in the UI — compliant with DUPR's "SSO-only" rule.

## Compliance notes for DUPR review

- **`dupr_id` is set in exactly one place**: `duprOauthCallback_` in `DuprApi.js` (search for `link_source = 'sso'`). All other code paths read it; none write.
- **No text input for DUPR ID anywhere**: the admin can't type one in; the player can't type one in. The only write path is verified OAuth.
- **Match-push gate**: `duprPushMatch_` refuses to push if any of the four players is missing a DUPR link. Error tells you who.
- **Audit trail**: `Audit_Log` records every link, every game save, every push attempt, every error. `DUPR_Push_Log` records the full request payload + response body for every push.
- **Token caching**: admin tokens live 12 hours, cached in CacheService + persisted to `Admin_Sessions`.

## What's stubbed / TODO

Search for `TODO(dupr-docs)` in `DuprApi.js` — three places where the exact path or field name needs verification against DUPR's current docs:

1. `/oauth/authorize` query params (scope name, response_type)
2. `/oauth/token` body shape
3. `/user/v1.0/me` field names for the DUPR ID + UUID

The match push endpoint (`/match/v1.0/create`) matches what the CPBL dupr-platform project already proved working — should be correct as-is, but double-check the JSON shape against your current docs.

## Diagnostics

From the Apps Script editor:

- `status()` — prints which Script Properties are set + the deployed URL
- `duprPing()` — calls `/user/v1.0/me` with your partner token; logs status + body. Quick way to confirm the base URL and token work.

## Pre-approved clasp commands

This sandbox is its own clasp project — its `clasp push` and `clasp deploy` are separate from the prod commands in `CLAUDE.md`. Always `cd sandbox/` first.
