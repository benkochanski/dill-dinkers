/**
 * Sheet helpers. Slimmed-down version of the prod Utils.js — no Firebase,
 * no per-league state, no league-version bumping. Just CRUD + audit + id gen.
 */

const _SHEET_CACHE     = {};
const _HEADER_CACHE    = {};
const _SHEET_REF_CACHE = {};

function _invalidateCache_(tableName) {
  delete _SHEET_CACHE[tableName];
  delete _HEADER_CACHE[tableName];
}

function getSheet_(name) {
  if (_SHEET_REF_CACHE[name]) return _SHEET_REF_CACHE[name];
  const ss = getMasterSpreadsheet_();
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error('Sheet not found: ' + name);
  _SHEET_REF_CACHE[name] = sh;
  return sh;
}

function getHeaders_(sheet) {
  const name = sheet.getName();
  if (_HEADER_CACHE[name]) return _HEADER_CACHE[name];
  const lastCol = sheet.getLastColumn();
  const headers = lastCol === 0
    ? []
    : sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  _HEADER_CACHE[name] = headers;
  return headers;
}

function getObjects_(tableName) {
  if (_SHEET_CACHE[tableName]) return _SHEET_CACHE[tableName];
  const sheet = getSheet_(tableName);
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol === 0) {
    _SHEET_CACHE[tableName] = [];
    return _SHEET_CACHE[tableName];
  }
  const headers = getHeaders_(sheet);
  const values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const out = values.map(row => {
    const obj = {};
    headers.forEach((h, i) => { if (h) obj[h] = row[i]; });
    return obj;
  });
  _SHEET_CACHE[tableName] = out;
  return out;
}

function appendObjects_(tableName, objects) {
  if (!objects || !objects.length) return 0;
  const sheet = getSheet_(tableName);
  const headers = getHeaders_(sheet);
  const rows = objects.map(o => headers.map(h => (h in o ? o[h] : '')));
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
  _invalidateCache_(tableName);
  return rows.length;
}

/** Overwrites all data rows (header preserved) with the provided objects. */
function overwriteObjects_(tableName, objects) {
  const sheet = getSheet_(tableName);
  const headers = getHeaders_(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, headers.length).clearContent();
  if (!objects || !objects.length) {
    _invalidateCache_(tableName);
    return 0;
  }
  const rows = objects.map(o => headers.map(h => (h in o ? o[h] : '')));
  sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  _invalidateCache_(tableName);
  return rows.length;
}

function updateWhere_(tableName, predicate, mutator) {
  const sheet = getSheet_(tableName);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const headers = getHeaders_(sheet);
  const range = sheet.getRange(2, 1, lastRow - 1, headers.length);
  const values = range.getValues();
  let touched = 0;
  values.forEach((row, i) => {
    const obj = {};
    headers.forEach((h, j) => { if (h) obj[h] = row[j]; });
    if (predicate(obj)) {
      mutator(obj);
      headers.forEach((h, j) => { if (h && (h in obj)) row[j] = obj[h]; });
      touched++;
    }
  });
  if (touched) {
    range.setValues(values);
    _invalidateCache_(tableName);
  }
  return touched;
}

function makeId_(kind) {
  const prefix = (CONFIG.ID_PREFIX && CONFIG.ID_PREFIX[kind]) || 'X';
  const t = Date.now().toString(36).toUpperCase();
  const r = Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, '0');
  return prefix + t + r;
}

function nowStamp_() {
  return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
}

/** Display-friendly format: "May 25, 2026 10:30 PM" */
function fmtDisplayStamp_(s) {
  if (!s) return '';
  let d;
  if (s instanceof Date) d = s;
  else {
    d = new Date(s);
    if (isNaN(d.getTime())) return String(s);
  }
  return Utilities.formatDate(d, CONFIG.TIMEZONE, 'MMM d, yyyy h:mm a');
}

function activeUserEmail_() {
  // Prefer the admin email resolved from the session token (set by
  // isAdminTokenValid_). Falls back to Session.getActiveUser() for
  // contexts where there's no admin token — e.g. doPost (webhook) or
  // self-service registration (where there's no actor at all).
  if (typeof _CURRENT_ADMIN_EMAIL !== 'undefined' && _CURRENT_ADMIN_EMAIL) {
    return _CURRENT_ADMIN_EMAIL;
  }
  try { return Session.getActiveUser().getEmail() || ''; }
  catch (e) { return ''; }
}

function audit_(action, entityType, entityId, oldVal, newVal) {
  try {
    appendObjects_('Audit_Log', [{
      audit_id:     makeId_('audit'),
      timestamp:    nowStamp_(),
      actor_email:  activeUserEmail_(),
      action:       action,
      entity_type:  entityType,
      entity_id:    entityId,
      old_value:    oldVal == null ? '' : JSON.stringify(oldVal),
      new_value:    newVal == null ? '' : JSON.stringify(newVal),
    }]);
  } catch (e) { /* swallow */ }
}

function wrap_(fn) {
  try {
    const data = fn();
    return { ok: true, data: JSON.parse(JSON.stringify(data == null ? null : data)) };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}
