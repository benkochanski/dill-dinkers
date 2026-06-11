/**
 * Idempotent bootstrap. Run from the Apps Script editor (function dropdown
 * → bootstrap → Run) once after setting SANDBOX_SHEET_ID in Script Properties.
 * Re-running is safe — only adds missing tabs / columns.
 *
 * Also: setAdminPasswordToValue() and setDuprCredentialsToValue() — edit the
 * literals, run, then re-edit to empty strings so plain secrets don't sit
 * in source.
 */

/**
 * One-shot first-time setup. Run this ONCE from the Apps Script editor
 * after pushing the code. It:
 *   1. Creates a new Google Sheet
 *   2. Saves its ID into Script Properties as SANDBOX_SHEET_ID
 *   3. Calls bootstrap() to create all the tabs
 *
 * Idempotent: if SANDBOX_SHEET_ID is already set, this just runs bootstrap().
 */
function setupSandbox() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('SANDBOX_SHEET_ID');
  if (id) {
    Logger.log('SANDBOX_SHEET_ID already set: %s — skipping Sheet creation.', id);
  } else {
    const ss = SpreadsheetApp.create('Dill Dinkers — Sandbox Data');
    id = ss.getId();
    props.setProperty('SANDBOX_SHEET_ID', id);
    Logger.log('Created Sheet: %s\nURL: %s', id, ss.getUrl());
  }
  return bootstrap();
}

function bootstrap() {
  const ss = getMasterSpreadsheet_();
  TAB_ORDER.forEach(name => {
    const def = SCHEMA[name];
    if (!def) return;
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const existingHeaders = sh.getLastColumn() === 0
      ? []
      : sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
    const missing = def.columns.filter(c => existingHeaders.indexOf(c) === -1);
    if (missing.length) {
      const allHeaders = existingHeaders.concat(missing);
      sh.getRange(1, 1, 1, allHeaders.length).setValues([allHeaders]);
      sh.getRange(1, 1, 1, allHeaders.length).setFontWeight('bold');
      sh.setFrozenRows(1);
    } else if (!existingHeaders.length) {
      sh.getRange(1, 1, 1, def.columns.length).setValues([def.columns]);
      sh.getRange(1, 1, 1, def.columns.length).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  });
  Logger.log('Bootstrap complete. Tabs: %s', TAB_ORDER.join(', '));
  return { ok: true, tabs: TAB_ORDER };
}

/* ----- Admin password (test admin) ----- */
function setAdminPasswordToValue() {
  // EDIT THIS LITERAL, run setAdminPasswordToValue, then reset to ''.
  const email = '';
  const password = '';
  if (!email || !password) {
    throw new Error('Edit setAdminPasswordToValue and supply both email and password literals.');
  }
  setAdminCredentials_(email, password);
  Logger.log('Admin credentials set for: ' + email);
}

function setAdminCredentials_(email, password) {
  if (!email || !password) throw new Error('email and password required');
  if (password.length < 8) throw new Error('password must be at least 8 characters');
  const hash = hashPassword_(password);
  PropertiesService.getScriptProperties().setProperties({
    ADMIN_EMAIL: String(email).trim().toLowerCase(),
    ADMIN_PASSWORD_HASH: hash,
  }, false);
  return { ok: true };
}

function hashPassword_(plain) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, plain, Utilities.Charset.UTF_8);
  return Utilities.base64Encode(digest);
}

/* ----- DUPR API credentials ----- */
function setDuprCredentialsToValue() {
  // Edit these, run, then reset to '' so plaintext secrets aren't in git.
  const base_url      = '';   // e.g. 'https://uat.mydupr.com/api' or production URL
  const client_id     = '';   // OAuth client_id from DUPR
  const client_secret = '';   // OAuth client_secret from DUPR
  const partner_token = '';   // Long-lived partner token for match push (if separate from OAuth)
  if (!base_url) throw new Error('Edit setDuprCredentialsToValue and supply at least base_url.');
  const props = { DUPR_BASE_URL: base_url };
  if (client_id)     props.DUPR_CLIENT_ID     = client_id;
  if (client_secret) props.DUPR_CLIENT_SECRET = client_secret;
  if (partner_token) props.DUPR_PARTNER_TOKEN = partner_token;
  PropertiesService.getScriptProperties().setProperties(props, false);
  Logger.log('DUPR credentials saved. Keys set: %s', Object.keys(props).join(', '));
}

/* ----- Destructive helpers (run from editor) ----- */

/** Delete all data rows from the Players tab. Header row preserved. */
function wipePlayers() {
  return _wipeTab_('Players');
}

/** Delete all data from Players + Games + DUPR_Push_Log. */
function wipeAll() {
  const out = {
    players: _wipeTab_('Players'),
    games:   _wipeTab_('Games'),
    push_log: _wipeTab_('DUPR_Push_Log'),
  };
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

function _wipeTab_(name) {
  const sh = getSheet_(name);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) {
    Logger.log('%s: already empty', name);
    return 0;
  }
  const lastCol = sh.getLastColumn();
  sh.getRange(2, 1, lastRow - 1, lastCol).clearContent();
  // Clear our in-memory cache so subsequent reads see the wipe.
  _invalidateCache_(name);
  audit_('wipe_tab', 'tab', name, { rows: lastRow - 1 }, null);
  Logger.log('%s: cleared %s rows', name, lastRow - 1);
  return lastRow - 1;
}

/* ----- Daily rating refresh (cron-driven) ----- */

/**
 * Refresh DUPR stats for every linked player. Designed to be wired to a
 * daily time-driven trigger as a backup for the webhook (in case a webhook
 * is missed). Logs counts to the execution log; appends per-player results
 * to Audit_Log.
 *
 * To install the trigger: function dropdown → installDailyRefreshTrigger → Run.
 */
function refreshAllPlayerRatings() {
  const players = getObjects_('Players');
  let attempted = 0, updated = 0, errored = 0, skipped = 0;
  players.forEach(p => {
    const dupr = String(p.dupr_id || '').trim();
    if (!dupr) { skipped++; return; }
    attempted++;
    try {
      const prof = duprFetchUserProfile_(dupr);
      const before = Object.assign({}, p);
      // Also refresh entitlements. Uses the wrapper that transparently
      // exchanges an expired access token for a fresh one via the stored
      // refreshToken — so daily cron stays healthy across multi-day gaps.
      let ent = null;
      if (p.dupr_user_token || p.dupr_refresh_token) {
        try { ent = fetchPlayerEntitlementsWithRefresh_(p); }
        catch (e) {
          audit_('entitlements_refresh_error', 'player', p.player_id, null,
            { error: String(e && e.message || e), source: 'daily_cron' });
        }
      }

      updateWhere_('Players',
        x => x.player_id === p.player_id,
        x => {
          // Refresh CURRENT only — registration rating is immutable.
          x.dupr_doubles_rating_current            = prof.doubles_rating || '';
          x.dupr_doubles_reliable_current          = prof.doubles_reliable ? 'TRUE' : 'FALSE';
          x.dupr_doubles_reliability_score_current = prof.doubles_reliability_score == null ? '' : prof.doubles_reliability_score;
          x.dupr_doubles_current_updated_at        = nowStamp_();
          // W/L are stats — keep updating in place (they represent current career counts).
          x.dupr_doubles_wins                      = prof.doubles_wins;
          x.dupr_doubles_losses                    = prof.doubles_losses;
          x.dupr_doubles_total                     = prof.doubles_total;
          // Singles (informational, current-only) + profile bio fields.
          x.dupr_singles_rating                    = prof.singles_rating || '';
          x.dupr_singles_reliable                  = prof.singles_reliable ? 'TRUE' : 'FALSE';
          x.dupr_singles_reliability_score         = prof.singles_reliability_score == null ? '' : prof.singles_reliability_score;
          x.dupr_singles_wins                      = prof.singles_wins;
          x.dupr_singles_losses                    = prof.singles_losses;
          x.dupr_singles_total                     = prof.singles_total;
          x.dupr_singles_updated_at                = nowStamp_();
          if (prof.age != null)        x.dupr_age        = prof.age;
          if (prof.birth_year != null) x.dupr_birth_year = prof.birth_year;
          if (prof.location)           x.dupr_location     = prof.location;
          if (prof.dupr_partial_name)  x.dupr_partial_name = prof.dupr_partial_name;
          if (prof.dupr_full_name)     x.dupr_full_name    = prof.dupr_full_name;
          if (prof.gender)             x.gender            = prof.gender;
          if (prof.email)              x.email             = prof.email;
          if (prof.phone)              x.phone             = prof.phone;
          x.dupr_stats_fetched_at                  = nowStamp_();
          // Entitlements (if refresh succeeded)
          if (ent) {
            x.entitlements_tournaments  = (ent.tournaments || []).join(',');
            x.has_basic_l1              = ent.has_basic_l1    ? 'TRUE' : 'FALSE';
            x.has_premium_l1            = ent.has_premium_l1  ? 'TRUE' : 'FALSE';
            x.has_verified_l1           = ent.has_verified_l1 ? 'TRUE' : 'FALSE';
            x.entitlements_fetched_at   = nowStamp_();
          }
        });
      updated++;
      audit_('rating_refresh', 'player', p.player_id, before, {
        rating: prof.doubles_rating, source: 'daily_cron'
      });
    } catch (e) {
      errored++;
      audit_('rating_refresh_error', 'player', p.player_id, null,
        { error: String(e && e.message || e) });
    }
    // Be polite to DUPR's rate limit.
    Utilities.sleep(200);
  });
  const summary = { attempted, updated, errored, skipped, total: players.length };
  Logger.log(JSON.stringify(summary, null, 2));
  return summary;
}

function installDailyRefreshTrigger() {
  // Remove existing triggers for this function first.
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'refreshAllPlayerRatings') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('refreshAllPlayerRatings')
    .timeBased()
    .everyDays(1)
    .atHour(3)  // 3 AM in script timezone
    .create();
  Logger.log('Daily refresh trigger installed for 3 AM.');
}

function removeDailyRefreshTrigger() {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'refreshAllPlayerRatings') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  Logger.log('Removed %s triggers.', removed);
}

/* ----- DUPR Club configuration ----- */

/**
 * Set the DUPR club this integration submits matches on behalf of. Required
 * for CLUB-source match pushes per DUPR's RaaS spec.
 *
 * Edit the literals → Run → reset literals to '' and save.
 */
function setDuprClubToValues() {
  const clubId      = '';   // e.g. '4575860854'
  const adminDuprId = '';   // DUPR ID of the user with DIRECTOR or ORGANIZER role
  if (!clubId || !adminDuprId) {
    throw new Error('Edit setDuprClubToValues and supply both DUPR_CLUB_ID and DUPR_ADMIN_DUPR_ID.');
  }
  PropertiesService.getScriptProperties().setProperties({
    DUPR_CLUB_ID:       String(clubId).trim(),
    DUPR_ADMIN_DUPR_ID: String(adminDuprId).trim(),
  }, false);
  Logger.log('Club config saved: clubId=%s admin=%s', clubId, adminDuprId);
}

/* ----- Diagnostics ----- */
function status() {
  const p = PropertiesService.getScriptProperties();
  const out = {
    sheet_id_set:        !!p.getProperty('SANDBOX_SHEET_ID'),
    admin_email:         p.getProperty('ADMIN_EMAIL') || '(unset)',
    admin_pwd_set:       !!p.getProperty('ADMIN_PASSWORD_HASH'),
    dupr_base_url:       p.getProperty('DUPR_BASE_URL') || '(unset)',
    dupr_client_id_set:  !!p.getProperty('DUPR_CLIENT_ID'),
    dupr_client_secret_set: !!p.getProperty('DUPR_CLIENT_SECRET'),
    dupr_partner_token_set: !!p.getProperty('DUPR_PARTNER_TOKEN'),
    deployed_url:        ScriptApp.getService().getUrl() || '(deploy first)',
  };
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}
