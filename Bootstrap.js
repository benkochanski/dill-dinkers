/**
 * One-time (and idempotent) initialization of the master Sheet.
 *
 * Run `bootstrap()` from the Apps Script editor on a fresh Sheet. It:
 *   1. Creates every tab listed in SCHEMA (skips if already there).
 *   2. Writes the header row from SCHEMA.<table>.columns.
 *   3. Adds any new columns at the end of an existing table (additive only —
 *      never removes or reorders, so it's safe to re-run after schema edits).
 *   4. Removes the default 'Sheet1' if no real data has been written there.
 *   5. Seeds the Config tab with sensible defaults if empty.
 *
 * Run again any time SCHEMA changes; existing data is preserved.
 */
function bootstrap() {
  const ss = getMasterSpreadsheet_();
  const summary = [];

  TABLE_ORDER.forEach(name => {
    const def = SCHEMA[name];
    if (!def) throw new Error('SCHEMA missing definition for ' + name);
    let sheet = ss.getSheetByName(name);
    let action;
    if (!sheet) {
      sheet = ss.insertSheet(name);
      writeHeaders_(sheet, def.columns);
      action = 'created';
    } else {
      action = ensureColumns_(sheet, def.columns);
    }
    summary.push(name + ': ' + action);
  });

  // Remove the auto-generated Sheet1 only if it's still empty.
  const sheet1 = ss.getSheetByName('Sheet1');
  if (sheet1 && sheet1.getLastRow() === 0 && sheet1.getLastColumn() === 0) {
    ss.deleteSheet(sheet1);
    summary.push('Sheet1: deleted (was empty)');
  }

  seedConfigDefaults_();

  const message = summary.join('\n');
  Logger.log(message);
  return message;
}

function writeHeaders_(sheet, columns) {
  if (!columns.length) return;
  sheet.getRange(1, 1, 1, columns.length).setValues([columns]).setFontWeight('bold');
  sheet.setFrozenRows(1);
}

/**
 * Compares existing header row to expected columns. Appends any missing
 * columns at the end. Returns 'ok' / 'extended (n)' / 'created'.
 */
function ensureColumns_(sheet, columns) {
  const have = getHeaders_(sheet);
  if (!have.length) {
    writeHeaders_(sheet, columns);
    return 'created (was empty)';
  }
  const missing = columns.filter(c => have.indexOf(c) === -1);
  if (!missing.length) return 'ok';
  const startCol = have.length + 1;
  sheet.getRange(1, startCol, 1, missing.length).setValues([missing]).setFontWeight('bold');
  return 'extended (+' + missing.length + ')';
}

/* ----- Diagnostics (in Bootstrap so they're available even if file tree is stale) ----- */

/** Logs what the script sees about the current user. */
function whoami() {
  const email = activeUserEmail_();
  const user = getCurrentUser_();
  const allRoles = getObjects_('Roles');
  const out = {
    activeUserEmail: email,
    seen_email: user.email,
    matched_role_rows: user.rows,
    roles: user.roles,
    isAdmin: user.isAdmin,
    fallbackAdmin: user.fallbackAdmin,
    all_roles_in_sheet: allRoles,
  };
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

/** Adds the running user to Roles as admin. Idempotent. */
function makeMeAdmin() {
  const me = (activeUserEmail_() || '').toLowerCase().trim();
  if (!me) throw new Error('Could not detect your email — Session.getActiveUser().getEmail() returned empty.');
  const all = getObjects_('Roles');
  const existing = all.find(r =>
    String(r.email || '').toLowerCase().trim() === me && r.role === 'admin');
  if (existing) {
    updateWhere_('Roles',
      r => String(r.email||'').toLowerCase().trim() === me && r.role === 'admin',
      r => { r.active = true; });
    Logger.log('Already admin — re-activated. Email: %s', me);
    return existing;
  }
  const row = {
    email: me, role: 'admin', scope_league_id: '', scope_team_id: '',
    active: true, notes: 'Added by makeMeAdmin', created_at: nowStamp_(),
  };
  appendObjects_('Roles', [row]);
  Logger.log('Added admin role for %s', me);
  return row;
}

/* ----- Internal ----- */

function seedConfigDefaults_() {
  const existing = getObjects_('Config');
  if (existing.length) return;
  const stamp = nowStamp_();
  const me = activeUserEmail_();
  appendObjects_('Config', [
    { key: 'app_name',       value: CONFIG.APP_NAME,        updated_at: stamp, updated_by: me },
    { key: 'default_weeks',  value: CONFIG.DEFAULT_WEEKS,   updated_at: stamp, updated_by: me },
    { key: 'admin_emails',   value: me,                     updated_at: stamp, updated_by: me },
    { key: 'deployment_url', value: '',                     updated_at: stamp, updated_by: me },
  ]);
  // Make the running user an admin by default so the first deploy isn't locked out.
  if (me) {
    appendObjects_('Roles', [{
      email: me, role: 'admin', scope_league_id: '', scope_team_id: '',
      active: true, notes: 'Auto-added during bootstrap', created_at: stamp,
    }]);
  }
}
