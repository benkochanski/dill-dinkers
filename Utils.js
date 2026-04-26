/**
 * Generic helpers for talking to Sheets as a database. Every read/write
 * funnels through here so we have one place to add caching, logging, etc.
 */

function getSheet_(name) {
  const ss = getMasterSpreadsheet_();
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error('Sheet not found: ' + name);
  return sh;
}

function getHeaders_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
}

/** Reads all data rows from a tab into an array of objects keyed by header. */
function getObjects_(tableName) {
  const sheet = getSheet_(tableName);
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol === 0) return [];
  const headers = getHeaders_(sheet);
  const values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  return values.map(row => {
    const obj = {};
    headers.forEach((h, i) => { if (h) obj[h] = row[i]; });
    return obj;
  });
}

/** Appends one or more objects to a tab. Missing keys become ''. */
function appendObjects_(tableName, objects) {
  if (!objects || !objects.length) return 0;
  const sheet = getSheet_(tableName);
  const headers = getHeaders_(sheet);
  const rows = objects.map(o => headers.map(h => (h in o ? o[h] : '')));
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
  return rows.length;
}

/** Overwrites all data rows (header preserved) with the provided objects. */
function overwriteObjects_(tableName, objects) {
  const sheet = getSheet_(tableName);
  const headers = getHeaders_(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, headers.length).clearContent();
  if (!objects || !objects.length) return 0;
  const rows = objects.map(o => headers.map(h => (h in o ? o[h] : '')));
  sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  return rows.length;
}

/**
 * Updates rows in-place that match a predicate. Returns the count of rows
 * touched. Use for status flips, etc.
 */
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
  if (touched) range.setValues(values);
  return touched;
}

function makeId_(kind) {
  const prefix = CONFIG.ID_PREFIX[kind] || 'X';
  const t = Date.now().toString(36).toUpperCase();
  const r = Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, '0');
  return prefix + t + r;
}

function nowStamp_() {
  return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
}

function activeUserEmail_() {
  try { return Session.getActiveUser().getEmail() || ''; }
  catch (e) { return ''; }
}

/** Best-effort audit: never throws even if the Audit_Log tab is missing. */
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
