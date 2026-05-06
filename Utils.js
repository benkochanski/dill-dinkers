/**
 * Generic helpers for talking to Sheets as a database. Every read/write
 * funnels through here so we have one place to add caching, logging, etc.
 *
 * Request-scoped cache: Apps Script V8 starts a fresh JS context per
 * execution, so module-level globals (`_SHEET_CACHE`, `_HEADER_CACHE`) reset
 * between API calls automatically. Within one execution, repeated reads of
 * the same tab hit memory. Writes invalidate the cache for that tab.
 *
 * This matters because a single `wrap_()` call can fan out into 4–6 helpers
 * that each re-read the same tabs (Players, Rosters, CR_Attendance, ...).
 * Without the cache, a busy page can saturate the Sheets read quota and
 * trigger RESOURCE_EXHAUSTED.
 */

const _SHEET_CACHE  = {};  // tableName → array of row objects
const _HEADER_CACHE = {};  // tableName → array of header strings
const _SHEET_REF_CACHE = {};  // tableName → Sheet handle

function _invalidateCache_(tableName) {
  delete _SHEET_CACHE[tableName];
  delete _HEADER_CACHE[tableName];
  // Sheet reference is durable; only cached objects get cleared.
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

/** Reads all data rows from a tab into an array of objects keyed by header. */
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

/** Appends one or more objects to a tab. Missing keys become ''. */
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
  if (touched) {
    range.setValues(values);
    _invalidateCache_(tableName);
  }
  return touched;
}

/* =========================================================================
 * Cross-request cache (CacheService)
 *
 * Survives between API calls — perfect for hot reads that change rarely
 * (Leagues, Roles, deployed app URL). Short TTLs keep staleness bounded;
 * mutators call cacheBust_(prefix) to invalidate.
 *
 * Keys:
 *   app:url                  → deployed web app URL (TTL 1 day)
 *   leagues:list             → all leagues (TTL 30s)
 *   league:<league_id>:full  → full api_getLeague payload (TTL 30s)
 *   roles:list               → all roles (TTL 60s)
 * ========================================================================= */

function _cache_() { return CacheService.getScriptCache(); }

/** Get-or-fetch a cached value. `fetcher` runs on miss; result is JSON-stored. */
function cacheGet_(key, ttlSec, fetcher) {
  const c = _cache_();
  const hit = c.get(key);
  if (hit !== null) {
    try { return JSON.parse(hit); } catch (e) { /* corrupt, refetch */ }
  }
  const value = fetcher();
  try { c.put(key, JSON.stringify(value), Math.max(1, Math.min(21600, ttlSec))); }
  catch (e) { /* over the 100KB limit — skip cache, return raw */ }
  return value;
}

/**
 * Invalidate cache entries by exact key, or by prefix (when key ends with ':').
 * CacheService doesn't support prefix scans, so we maintain a small index list.
 */
function cacheBust_(keyOrPrefix) {
  const c = _cache_();
  // Plain delete handles all our exact keys + the broad bucket cases.
  c.remove(keyOrPrefix);
  // For prefix-style keys, also nuke common siblings we know about.
  if (keyOrPrefix === 'leagues:' || keyOrPrefix === 'league:') {
    c.removeAll(['leagues:list']);
  }
  if (keyOrPrefix === 'roles:') c.removeAll(['roles:list']);
}

/** Bust everything we know how to bust. Use after big writes (wipe, reset). */
function cacheBustAll_() {
  try {
    _cache_().removeAll(['app:url', 'leagues:list', 'roles:list']);
  } catch (e) { /* ignore */ }
}

/* =========================================================================
 * Per-league live state for cross-machine updates.
 *
 * Stored in CacheService at key `ls:<league_id>` as JSON `{version, week, half}`.
 *   - version: monotonic integer; bumped on any mutation that affects Display
 *   - week / half: the half the Operator is currently working on. Display
 *     mirrors this — no manual toggle needed.
 *
 * Display tabs poll `api_getLeagueState(league_id)` cheaply (sub-second) and
 * react when the version changes (full content refresh) or when week/half
 * changes (also switch the displayed half).
 * ========================================================================= */
function _readLeagueState_(league_id) {
  if (!league_id) return { version: 0, week: null, half: null, courts: [] };
  try {
    const raw = _cache_().get('ls:' + league_id);
    if (raw) {
      const obj = JSON.parse(raw);
      return {
        version: Number(obj.version) || 0,
        week:    obj.week == null ? null : Number(obj.week),
        half:    obj.half == null ? null : Number(obj.half),
        courts:  Array.isArray(obj.courts) ? obj.courts.map(Number).filter(n => n > 0) : [],
      };
    }
  } catch (e) { /* swallow */ }
  return { version: 0, week: null, half: null, courts: [] };
}

function _writeLeagueState_(league_id, state) {
  if (!league_id) return;
  try { _cache_().put('ls:' + league_id, JSON.stringify(state), 21600); }
  catch (e) { /* swallow */ }
}

function bumpLeagueVersion_(league_id) {
  if (!league_id) return;
  const s = _readLeagueState_(league_id);
  s.version = (Number(s.version) || 0) + 1;
  _writeLeagueState_(league_id, s);
}

function setActiveHalf_(league_id, week, half, courts) {
  if (!league_id) return;
  const s = _readLeagueState_(league_id);
  s.version = (Number(s.version) || 0) + 1;
  if (week != null) s.week = Number(week);
  if (half != null) s.half = Number(half);
  if (courts != null) {
    s.courts = Array.isArray(courts)
      ? courts.map(Number).filter(n => n > 0)
      : String(courts).split(/[,\s]+/).map(Number).filter(n => n > 0);
  }
  _writeLeagueState_(league_id, s);
}

function getLeagueState_(league_id) {
  return _readLeagueState_(league_id);
}

/** Back-compat: simple version-only getter. */
function getLeagueVersion_(league_id) {
  return _readLeagueState_(league_id).version;
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
