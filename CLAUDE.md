# Dill Dinkers League Manager

Apps Script web app + single master Google Sheet for managing 12+ pickleball leagues per season. Two formats: **ladder** (individual standings, doubles with rotating partners) and **partner** (team-vs-team, fixed pairs).

## Architecture in two minutes

```
Master Sheet (one sheet, 15 tabs)               GAS web app (single doGet)
  Config           Players                       ?page=home    landing
  Roles            Rosters                       ?page=admin    7 tabs
  Leagues          Teams                         ?page=operator entry + standings
  League_Schedule  Session_Groups                ?page=display  TV scoreboard
  Match_Schedule   Games                         ?page=player   (stub)
  Substitutions    DUPR
  Email_Log        Audit_Log
  Bonus_Config
```

All data is one row per fact; standings/displays are computed on demand from `Games` + `Bonus_Config` (no derived tabs to keep in sync).

## Code map

- `Config.js` — sheet ID, app name, ID prefixes
- `Schema.js` — every tab definition + column order. **Source of truth for the schema.** Add a column → re-run `bootstrap` (additive only)
- `Bootstrap.js` — `bootstrap()` creates/extends tabs and seeds the running user as admin. Also has `whoami()` and `makeMeAdmin()` for diagnostics
- `Utils.js` — `getObjects_`, `appendObjects_`, `overwriteObjects_`, `updateWhere_`, `makeId_`, `nowStamp_`, `audit_`
- `Auth.js` — per-request role lookup. Reads `Roles`. Falls back to admin if `Roles` is empty (bootstrap escape hatch)
- `Roles.js` — admin CRUD over the Roles tab + audit reader
- `Web.js` — `doGet` router, HTML page renderers, `htmlError_` / `escapeHtml_`
- `Api.js` — every `api_*` function exposed to HTML via `google.script.run`. **Trust boundary**: each entry point resolves the user, requires a role, wraps the result in `{ok, data}` or `{ok:false, error}`. `wrap_` JSON-roundtrips the response so Date objects don't tank the wire
- `Leagues.js` — `createLeague_`, `listLeagues_`, `getLeagueSchedule_`. Auto-seeds `Bonus_Config` for ladder
- `Players.js` — `upsertPlayer_` (by email), `addToRoster_`, `createTeam_`, `slotIntoTeam_`, `bulkAddPlayersToLeague_`, `listRoster_`, `listTeams_`
- `Games.js` — `saveGame_`, `updateGame_`, `voidGame_`, `computeWinner_`, `listGames_`
- `Standings.js` — `recomputeStandings_(league_id)` dispatches by `format_type`. `computeLadderStandings_` (composite Score = 0.6·W% + 0.4·P% + bonuses), `computePartnerStandings_` (W-L + +/- + GB)
- `Schedule.js` — `generatePartnerSchedule_` (circle-method round-robin → `Match_Schedule` rows)
- `Subs.js` — `recordSubstitution_` + optional MailApp notification
- `Email.js` — `bulkEmailLeague_` with placeholder substitution + `Email_Log`
- `Export.js` — `exportCsv_(league_id, kind)` for `roster | teams | scores | standings | subs`
- `SeedTest.js` — `seedTestLadder()` / `seedTestPartner()` + debug helpers

HTML pages: `Home.html`, `Admin.html` (7 tabs: Leagues / Roster / Subs / Email / Export / Roles / Audit), `Operator.html` (format-aware game entry + live standings), `Display.html` (TV scoreboard, auto-refresh 30s).

Player roster intake is direct (no staging/approval): the Roster tab has a single-player form + bulk-paste textarea (`full_name, email, phone, level, dupr_id, team_name`, comma- or tab-separated). For partner format, players sharing the same `team_name` auto-merge into a Team.

## Bonus formula (ladder only)

For each game in week ≥ `league.bonus_starts_week`:
- **W bonus** += group multiplier (only when player won the game)
- **P bonus** += group multiplier (every qualifying game)

Multiplier = `(num_groups - group_rank) × 0.03` so bottom group is 0. Stored explicitly per row in `Bonus_Config` so each league can override.

`Score = (0.6 × W% + 0.4 × P%) × 100`
`W% = (wins + W_bonus) / games_played`
`P% = (points_for + P_bonus) / (games_played × 11)`

## Common tasks

**Add a column to a tab**: edit `Schema.js`, push, run `bootstrap()`. It only adds — never removes or reorders.

**Create a real league**: Admin → Leagues tab → fill form → Create. For ladder, set `# Groups` so Bonus_Config seeds correctly.

**Add players to a league**: Admin → Roster tab → pick the league → either fill the single-player form or paste rows into the bulk textarea (`Name, email, phone, level, dupr, team_name`). For partner format, two players sharing the same `team_name` auto-merge into a Team.

**Add an operator**: Admin → Roles tab → email + role + (optional) league scope → Add.

**Deploy a fresh version**: `clasp push` updates the `/dev` URL automatically. For `/exec` (production), Apps Script editor → Deploy → Manage deployments → New version.

## Quirks worth knowing

1. **`google.script.run` won't transmit Date objects.** Any return value containing a Date silently becomes `null`. `wrap_` in Api.js does a JSON-roundtrip to coerce Dates → ISO strings. If you write a new endpoint that bypasses `wrap_`, mind the Dates yourself.
2. **Sheet booleans round-trip as the string `'TRUE'` sometimes.** `Auth.js` and `onRoles` both tolerate either form. Don't `===  true`.
3. **Function dropdown caches.** After `clasp push`, the editor needs a hard refresh before new functions appear in the Run dropdown. Same for new files.
4. **Mail quotas**: ~100/day on personal Google accounts, 1500/day on Workspace. Bulk email logs success/error per recipient in `Email_Log`.
5. **Bootstrap is additive.** Re-running it after a schema change extends columns but never removes them. If you actually need to drop a column, do it manually in the Sheet.
6. **Apps Script web app deployments are version-pinned.** `/exec` URLs serve the version that was current when you deployed; `/dev` URLs always serve the latest pushed code. For active dev, use `/dev`. For production / TVs, deploy a versioned `/exec` and update it explicitly when you want to ship.

## Test data

`seedTestLadder()` — "TEST Ladder" with 8 players, 6 groups, week 1 + week 3 games hitting groups 1/3/6 to exercise the bonus formula. `debugStandings()` logs the computed standings.

`seedTestPartner()` — "TEST Partners" with 4 teams, 1 week, 6 round-robin games. `debugPartnerStandings()` logs the team standings.

Both are idempotent: re-running won't double-create the league or its games.
