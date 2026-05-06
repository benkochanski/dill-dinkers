/**
 * CourtReserve API client.
 *
 * Docs: https://api.courtreserve.com/swagger/ui/index
 *
 * Auth: Basic (username + password issued by CourtReserve when API access is
 *   enabled in Settings → Additional Features → Integrations for an Org-level
 *   account, or via Customer Success for Enterprise).
 * Rate limit: 60 req/min per key. 429 returns a Retry-After header in seconds.
 * Transport: HTTPS + JSON only.
 *
 * Credentials live in Script Properties (NOT in the Sheet, NOT in code) so they
 * never round-trip through google.script.run and are not visible to anyone with
 * Sheet read access. Keys:
 *   CR_USERNAME   — API username
 *   CR_PASSWORD   — API password
 *   CR_BASE_URL   — base URL, defaults to https://api.courtreserve.com
 *   CR_MODE       — 'org' (default) or 'enterprise', purely informational
 *   CR_ORG_ID     — optional, some Org endpoints require it as a query param
 *
 * Public surface used by Api.js:
 *   crGetStatus_()                — { configured, mode, base_url, has_password, org_id }
 *   crSetCredentials_(input)      — write any of username/password/base_url/mode/org_id
 *   crClearCredentials_()         — wipe all CR_* properties
 *   crPing_()                     — quick connectivity probe
 *   crFetch_(method, path, opts)  — raw call, returns { status, headers, body }
 */

const CR_PROP_KEYS = ['CR_USERNAME', 'CR_PASSWORD', 'CR_BASE_URL', 'CR_MODE', 'CR_ORG_ID'];
const CR_DEFAULT_BASE_URL = 'https://api.courtreserve.com';

function crProps_() {
  return PropertiesService.getScriptProperties();
}

function crGetCredentials_() {
  const p = crProps_();
  return {
    username: p.getProperty('CR_USERNAME') || '',
    password: p.getProperty('CR_PASSWORD') || '',
    base_url: p.getProperty('CR_BASE_URL') || CR_DEFAULT_BASE_URL,
    mode:     p.getProperty('CR_MODE')     || 'org',
    org_id:   p.getProperty('CR_ORG_ID')   || '',
  };
}

/** Status without leaking secrets — safe to return to the admin UI. */
function crGetStatus_() {
  const c = crGetCredentials_();
  return {
    configured:    !!(c.username && c.password),
    has_username:  !!c.username,
    has_password:  !!c.password,
    username:      c.username,
    base_url:      c.base_url,
    mode:          c.mode,
    org_id:        c.org_id,
  };
}

/**
 * Set or update credentials. Pass only the keys you want to change.
 * Empty string clears that key. Returns the new status.
 */
function crSetCredentials_(input) {
  input = input || {};
  const p = crProps_();
  const before = crGetStatus_();
  const map = {
    CR_USERNAME: 'username',
    CR_PASSWORD: 'password',
    CR_BASE_URL: 'base_url',
    CR_MODE:     'mode',
    CR_ORG_ID:   'org_id',
  };
  Object.keys(map).forEach(propKey => {
    const inputKey = map[propKey];
    if (inputKey in input) {
      const v = String(input[inputKey] == null ? '' : input[inputKey]).trim();
      if (v === '') p.deleteProperty(propKey);
      else p.setProperty(propKey, v);
    }
  });
  const after = crGetStatus_();
  audit_('cr_credentials_update', 'integration', 'courtreserve',
    { configured: before.configured, mode: before.mode, base_url: before.base_url },
    { configured: after.configured,  mode: after.mode,  base_url: after.base_url });
  return after;
}

function crClearCredentials_() {
  const p = crProps_();
  CR_PROP_KEYS.forEach(k => p.deleteProperty(k));
  audit_('cr_credentials_clear', 'integration', 'courtreserve', null, null);
  return crGetStatus_();
}

/**
 * Low-level fetch. Handles Basic Auth, JSON encoding, and a single 429 retry
 * honoring Retry-After (capped at 30s so we don't hang a UI request).
 *
 * @param {string} method — GET/POST/PUT/DELETE/PATCH
 * @param {string} path   — path beginning with '/', or full URL
 * @param {Object} opts   — { query?: Object, body?: any, headers?: Object }
 * @returns {{ status:number, headers:Object, body:any, raw:string, url:string }}
 */
function crFetch_(method, path, opts) {
  opts = opts || {};
  const c = crGetCredentials_();
  if (!c.username || !c.password) {
    throw new Error('CourtReserve credentials not configured. Admin → Integrations.');
  }

  const url = crBuildUrl_(c.base_url, path, opts.query);
  const headers = Object.assign({
    'Authorization': 'Basic ' + Utilities.base64Encode(c.username + ':' + c.password),
    'Accept':        'application/json',
  }, opts.headers || {});

  const params = {
    method: String(method || 'GET').toLowerCase(),
    muteHttpExceptions: true,
    headers: headers,
    followRedirects: true,
  };
  if (opts.body !== undefined && opts.body !== null) {
    params.contentType = 'application/json';
    params.payload = (typeof opts.body === 'string') ? opts.body : JSON.stringify(opts.body);
  }

  let resp = UrlFetchApp.fetch(url, params);
  let status = resp.getResponseCode();

  if (status === 429) {
    const ra = Number(resp.getHeaders()['Retry-After'] || resp.getHeaders()['retry-after'] || 0);
    const waitSec = Math.min(Math.max(ra || 1, 1), 30);
    Utilities.sleep(waitSec * 1000);
    resp = UrlFetchApp.fetch(url, params);
    status = resp.getResponseCode();
  }

  const raw = resp.getContentText();
  let body = raw;
  const ct = String(resp.getHeaders()['Content-Type'] || resp.getHeaders()['content-type'] || '');
  if (ct.indexOf('application/json') !== -1 && raw) {
    try { body = JSON.parse(raw); } catch (e) { /* leave as text */ }
  }
  return { status: status, headers: resp.getHeaders(), body: body, raw: raw, url: url };
}

/**
 * GET helper that throws on non-2xx. Most callers want this.
 * @returns parsed JSON body (or raw text if not JSON).
 */
function crGet_(path, query) {
  const r = crFetch_('GET', path, { query: query });
  crAssertOk_(r);
  return r.body;
}

function crPost_(path, body, query) {
  const r = crFetch_('POST', path, { body: body, query: query });
  crAssertOk_(r);
  return r.body;
}

function crAssertOk_(r) {
  if (r.status >= 200 && r.status < 300) return;
  const msg = (r.body && r.body.message) || (r.body && r.body.error) || r.raw || ('HTTP ' + r.status);
  const err = new Error('CourtReserve ' + r.status + ': ' + String(msg).slice(0, 500));
  err.status = r.status;
  err.url = r.url;
  throw err;
}

function crBuildUrl_(base, path, query) {
  let url;
  if (/^https?:\/\//i.test(path)) {
    url = path;
  } else {
    const b = String(base || CR_DEFAULT_BASE_URL).replace(/\/+$/, '');
    const p = String(path || '/').replace(/^\/?/, '/');
    url = b + p;
  }
  if (query && typeof query === 'object') {
    const qs = Object.keys(query)
      .filter(k => query[k] !== undefined && query[k] !== null && query[k] !== '')
      .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(String(query[k])))
      .join('&');
    if (qs) url += (url.indexOf('?') === -1 ? '?' : '&') + qs;
  }
  return url;
}

/**
 * Quick connectivity probe. Tries a couple of harmless endpoints and reports
 * whichever one responds first. Returns enough detail for the admin UI to show
 * "ok" vs "auth failed" vs "rate limited" vs "endpoint not found".
 *
 * If none of the probes match a real endpoint on your account, the call will
 * still return — auth-failure (401/403) is just as useful a signal as 200.
 */
function crPing_() {
  const c = crGetCredentials_();
  if (!c.username || !c.password) {
    return { ok: false, status: 0, message: 'Credentials not configured.' };
  }

  const probes = [
    CR_API_PREFIX + '/member/get',
    CR_API_PREFIX + '/eventcalendar/eventlist',
    CR_API_PREFIX + '/eventregistrationreport/listactive',
  ];

  let last = null;
  for (let i = 0; i < probes.length; i++) {
    try {
      const r = crFetch_('GET', probes[i]);
      last = { ok: r.status >= 200 && r.status < 300, status: r.status, path: probes[i],
               url: r.url, sample: crSample_(r.body) };
      if (last.ok) {
        crLogSync_({ kind: 'ping', method: 'GET', path: probes[i], http_status: r.status, status: 'ok' });
        return last;
      }
      if (r.status === 401 || r.status === 403) {
        last.message = 'Auth failed (HTTP ' + r.status + '). Check username/password.';
        crLogSync_({ kind: 'ping', method: 'GET', path: probes[i], http_status: r.status,
                     status: 'error', message: last.message });
        return last;
      }
      if (r.status === 429) {
        last.message = 'Rate limited.';
        crLogSync_({ kind: 'ping', method: 'GET', path: probes[i], http_status: 429,
                     status: 'rate_limited', message: 'Retry-After exhausted' });
        return last;
      }
    } catch (e) {
      last = { ok: false, status: 0, path: probes[i], message: String(e && e.message || e) };
    }
  }
  if (last) {
    crLogSync_({ kind: 'ping', method: 'GET', path: last.path || '', http_status: last.status || '',
                 status: 'error', message: last.message || 'No 2xx from any probe' });
  }
  return last || { ok: false, status: 0, message: 'No probes attempted.' };
}

/** Truncate a response body for safe display. */
function crSample_(body) {
  try {
    const s = (typeof body === 'string') ? body : JSON.stringify(body);
    return s.length > 400 ? s.slice(0, 400) + '…' : s;
  } catch (e) { return ''; }
}

/**
 * Append a row to CR_Sync_Log. Best-effort — never throws.
 * `kind` is a free-form label ('ping', 'members_pull', etc).
 */
function crLogSync_(row) {
  try {
    appendObjects_('CR_Sync_Log', [Object.assign({
      sync_id:     makeId_('audit'),
      started_at:  nowStamp_(),
      finished_at: nowStamp_(),
      actor_email: activeUserEmail_(),
      kind:        '',
      method:      '',
      path:        '',
      http_status: '',
      count:       '',
      status:      'ok',
      message:     '',
    }, row || {})]);
  } catch (e) { /* swallow */ }
}

function crListSyncLog_(limit) {
  const rows = getObjects_('CR_Sync_Log');
  rows.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
  return rows.slice(0, Number(limit) || 50);
}

/**
 * Unwrap the standard CourtReserve envelope:
 *   { ErrorMessage, Data: [...], IsSuccessStatusCode }
 * Throws if IsSuccessStatusCode is false. Returns Data, or the body itself
 * if the envelope isn't present.
 */
function crUnwrap_(body) {
  if (body && typeof body === 'object' && 'IsSuccessStatusCode' in body) {
    if (body.IsSuccessStatusCode === false) {
      throw new Error('CourtReserve: ' + (body.ErrorMessage || 'unknown error'));
    }
    return ('Data' in body) ? body.Data : body;
  }
  return body;
}

/**
 * Real CourtReserve API base path. Endpoints are flat under /api/v1/, not
 * org-nested. Each endpoint also requires a corresponding "role" with
 * Read/Write permission to be granted to the API key in CourtReserve.
 */
const CR_API_PREFIX = '/api/v1';

/**
 * Fetch event registrations from CourtReserve.
 *
 * Endpoints:
 *   /api/v1/eventregistrationreport/listactive    — active registrations
 *   /api/v1/eventregistrationreport/listcancelled — cancelled registrations
 *   /api/v1/eventregistrationreport/listwaitlist  — waitlist
 *
 * Required role: EventRegistrationReport (Read).
 *
 * The CR API caps each call at a 31-day date range. We automatically chunk
 * longer ranges into 31-day windows and concatenate results.
 *
 * Filters (all optional):
 *   path             — override the endpoint path entirely
 *   eventId          — filter to a single EventId (client-side)
 *   eventCategoryId  — filter by category (client-side)
 *   startDate        — yyyy-MM-dd, mapped to filters.dateBy field below
 *   endDate          — yyyy-MM-dd, ditto
 *   dateBy           — 'event' (default) → eventDateFrom/To
 *                    — 'registered'      → registeredOnFrom/To
 *   includePartnerInfo — bool, default true (we usually want partner info)
 *   includeCourts    — bool, default false
 *   includeUserDefinedFields — bool, default false
 *   includeCancelled — bool, default false. When true, also fetches /listcancelled.
 *   includeWaitlist  — bool, default false. When true, also fetches /listwaitlist.
 */
function crListEventRegistrations_(filters) {
  filters = filters || {};

  const paths = filters.path
    ? [filters.path]
    : [CR_API_PREFIX + '/eventregistrationreport/listactive']
        .concat(filters.includeCancelled ? [CR_API_PREFIX + '/eventregistrationreport/listcancelled'] : [])
        .concat(filters.includeWaitlist  ? [CR_API_PREFIX + '/eventregistrationreport/listwaitlist']  : []);

  const dateBy = (filters.dateBy === 'registered') ? 'registered' : 'event';
  const fromKey = dateBy === 'registered' ? 'registeredOnFrom' : 'eventDateFrom';
  const toKey   = dateBy === 'registered' ? 'registeredOnTo'   : 'eventDateTo';

  const startStr = filters.startDate;
  const endStr   = filters.endDate;
  if (!filters.path && (!startStr || !endStr)) {
    throw new Error('CourtReserve event registrations need both startDate and endDate.');
  }

  const chunks = startStr && endStr ? crChunkDateRange_(startStr, endStr, 31) : [[null, null]];

  let combined = [];
  paths.forEach(p => {
    chunks.forEach(pair => {
      const q = {
        includePartnerInfo:       true,
        includeCourts:            true,
        includeUserDefinedFields: true,
      };
      // Server-side filters are best-effort: CR silently ignores unknown
      // params and (verified 2026-05) ignores session-id filters on
      // /listactive. We still send categoryIds in case the server starts
      // honoring it; client-side filter below catches it either way.
      if (filters.eventCategoryId) q.eventCategoryIds = filters.eventCategoryId;
      if (pair[0] && pair[1]) {
        q[fromKey] = pair[0];
        q[toKey]   = pair[1];
      }
      const body = crGet_(p, q);
      const data = crUnwrap_(body);
      if (Array.isArray(data)) combined = combined.concat(data);
    });
  });

  // Client-side filters as belt-and-suspenders: also work if the server
  // doesn't honor the corresponding query param.
  if (filters.eventId !== undefined && filters.eventId !== null && filters.eventId !== '') {
    const wants = String(filters.eventId).split(',').map(s => s.trim()).filter(Boolean);
    if (wants.length) combined = combined.filter(r => wants.indexOf(String(r.EventId)) !== -1);
  }
  // EventCategoryId is the practical "league bucket" filter — CR's web UI
  // exposes Event Sessions but the API silently ignores session-id params
  // on /listactive, so category is what we use. Comma-separated supported.
  if (filters.eventCategoryId !== undefined && filters.eventCategoryId !== null && filters.eventCategoryId !== '') {
    const wants = String(filters.eventCategoryId).split(',').map(s => s.trim()).filter(Boolean);
    if (wants.length) combined = combined.filter(r => wants.indexOf(String(r.EventCategoryId)) !== -1);
  }
  return combined;
}

/**
 * Split a yyyy-MM-dd date range into ≤maxDays-wide chunks. Each chunk pair is
 * [startISO, endISO] with full ISO datetimes (00:00:00 → 23:59:59 in UTC), so
 * we hit CR's $date-time-typed query params correctly.
 */
function crChunkDateRange_(startStr, endStr, maxDays) {
  const parse = s => {
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  };
  const startMs = parse(startStr);
  const endMs   = parse(endStr);
  if (startMs == null || endMs == null || endMs < startMs) return [[startStr, endStr]];

  const dayMs = 86400000;
  const out = [];
  let cursor = startMs;
  while (cursor <= endMs) {
    const sliceEnd = Math.min(cursor + (maxDays - 1) * dayMs, endMs);
    out.push([
      new Date(cursor).toISOString().slice(0, 10)   + 'T00:00:00Z',
      new Date(sliceEnd).toISOString().slice(0, 10) + 'T23:59:59Z',
    ]);
    cursor = sliceEnd + dayMs;
  }
  return out;
}

/**
 * Fetch the event list. Useful for populating an event picker.
 * Endpoint: GET /api/v1/eventcalendar/eventlist
 * Required role: EventCalendar (Read)
 */
function crListEvents_(filters) {
  filters = filters || {};
  const path = filters.path || (CR_API_PREFIX + '/eventcalendar/eventlist');
  const query = {};
  if (filters.startDate) query.startDate = filters.startDate;
  if (filters.endDate)   query.endDate   = filters.endDate;
  const body = crGet_(path, query);
  const data = crUnwrap_(body);
  return Array.isArray(data) ? data : [];
}

/* =========================================================================
 * CR Registrations staging
 *
 * Workflow:
 *   1. pullRegistrationsToStaging_(filters)  — fetch from CR, upsert to
 *                                              CR_Registrations table.
 *   2. listStagedRegistrations_(filter)      — query the table for the UI.
 *   3. assignStagedRegistrationsToLeague_(reg_ids, league_id)
 *                                            — for each row in reg_ids,
 *                                              upsert Player + Roster (and
 *                                              Team for partner format),
 *                                              mark assigned in staging.
 *
 * Dedup on pull: (cr_member_id, cr_event_date_id) when member_id exists,
 * otherwise (email, cr_event_date_id). Updates status / cancelled_on /
 * partners_json on existing rows; preserves assigned_* fields.
 * ========================================================================= */

/**
 * Dedup key: (member_id OR 'e:'+email) | cr_event_id | signed_up_on_date
 * Collapses multiple weekly sessions of the same registration into one row.
 * signedUpOn is a full ISO datetime; we truncate to the date portion.
 */
function _crRegDedupKey_(memberId, email, eventId, signedUpOn) {
  const m = memberId ? String(memberId) : '';
  const e = (email || '').toLowerCase().trim();
  const eid = eventId ? String(eventId) : '';
  const d = signedUpOn ? String(signedUpOn).slice(0, 10) : '';
  return (m || ('e:' + e)) + '|' + eid + '|' + d;
}

/**
 * Pull event registrations from CourtReserve into the CR_Registrations table.
 * Returns { added, updated, total }.
 */
function pullRegistrationsToStaging_(filters) {
  filters = filters || {};
  if (!filters.startDate || !filters.endDate) {
    throw new Error('Need both Start date and End date.');
  }
  // Always restrict to category 48794 (League). Override not permitted from UI.
  filters = Object.assign({}, filters, { eventCategoryId: '48794' });
  const regsRaw = crListEventRegistrations_(filters);

  // Pre-deduplicate the CR response on (member_id|email, event_id, signed_up_on_date).
  // CR returns one row per EventDateId (session), so a single registration for a
  // 10-week league produces 10 rows. We keep only the first occurrence of each key.
  const seenInBatch = {};
  const regs = regsRaw.filter(reg => {
    const k = _crRegDedupKey_(reg.OrganizationMemberId, reg.Email, reg.EventId, reg.SignedUpOnUtc);
    if (seenInBatch[k]) return false;
    seenInBatch[k] = true;
    return true;
  });

  const existing = getObjects_('CR_Registrations');
  const byKey = {};
  existing.forEach(r => {
    byKey[_crRegDedupKey_(r.cr_member_id, r.email, r.cr_event_id, r.signed_up_on)] = r;
  });

  const toAppend = [];
  const updates = [];

  regs.forEach(reg => {
    const key = _crRegDedupKey_(reg.OrganizationMemberId, reg.Email, reg.EventId, reg.SignedUpOnUtc);
    const status = reg.CancelledOnUtc ? 'cancelled' : 'active';
    const prev = byKey[key];

    // Registration type from CR — varies by endpoint. Try common fields.
    const regType = reg.RegistrationTypeDisplay
                 || reg.RegistrationType
                 || reg.RegistrationTypeName
                 || reg.RegistrationOption
                 || reg.RegistrationOptionName
                 || reg.EventRegistrationType
                 || reg.RegistrationName
                 || reg.Type
                 || (reg.RegistrationTypeId ? 'Type ' + reg.RegistrationTypeId : '')
                 || (reg.IsDropIn ? 'Drop In' : '')
                 || '';

    if (prev) {
      updates.push({
        cr_reg_id: prev.cr_reg_id,
        patch: {
          imported_at:                nowStamp_(),
          status:                     status,
          cancelled_on:               reg.CancelledOnUtc || '',
          registration_type:          regType,
          partners_json:              JSON.stringify(reg.PartnersInfo || []),
          price_to_pay:               reg.PriceToPay != null ? reg.PriceToPay : '',
          paid_amount:                reg.PaidAmount != null ? reg.PaidAmount : '',
          unsub_marketing_email:      reg.UnsubscribeFromMarketingEmails != null ? !!reg.UnsubscribeFromMarketingEmails : '',
          unsub_marketing_text:       reg.UnsubscribeFromMarketingTextAlerts != null ? !!reg.UnsubscribeFromMarketingTextAlerts : '',
          courts_json:                JSON.stringify(reg.Courts || []),
          user_defined_fields_json:   JSON.stringify(reg.UserDefinedFields || []),
          raw_json:                   JSON.stringify(reg),
          // keep assigned_* fields intact
        },
      });
    } else {
      const newRow = {
        cr_reg_id:                  makeId_('audit'),
        imported_at:                nowStamp_(),
        cr_event_id:                reg.EventId || '',
        event_name:                 reg.EventName || '',
        cr_category_id:             reg.EventCategoryId || '',
        category_name:              reg.EventCategoryName || '',
        cr_event_date_id:           reg.EventDateId || '',
        event_start:                reg.StartTime || '',
        event_end:                  reg.EndTime || '',
        registration_type:          regType,
        is_team_event:              !!reg.IsTeamEvent,
        cr_member_id:               reg.OrganizationMemberId ? String(reg.OrganizationMemberId) : '',
        first_name:                 reg.FirstName || '',
        last_name:                  reg.LastName || '',
        email:                      (reg.Email || '').toLowerCase().trim(),
        phone:                      reg.Phone || '',
        partners_json:              JSON.stringify(reg.PartnersInfo || []),
        price_to_pay:               reg.PriceToPay != null ? reg.PriceToPay : '',
        paid_amount:                reg.PaidAmount != null ? reg.PaidAmount : '',
        unsub_marketing_email:      reg.UnsubscribeFromMarketingEmails != null ? !!reg.UnsubscribeFromMarketingEmails : '',
        unsub_marketing_text:       reg.UnsubscribeFromMarketingTextAlerts != null ? !!reg.UnsubscribeFromMarketingTextAlerts : '',
        courts_json:                JSON.stringify(reg.Courts || []),
        user_defined_fields_json:   JSON.stringify(reg.UserDefinedFields || []),
        raw_json:                   JSON.stringify(reg),
        signed_up_on:               reg.SignedUpOnUtc || '',
        cancelled_on:               reg.CancelledOnUtc || '',
        status:                     status,
        assigned_league_id:         '',
        assigned_team_id:           '',
        assigned_player_id:         '',
        assigned_at:                '',
      };
      toAppend.push(newRow);
      byKey[key] = newRow; // prevent duplicates within the same pull batch
    }
  });

  if (toAppend.length) appendObjects_('CR_Registrations', toAppend);
  if (updates.length) {
    const patchById = {};
    updates.forEach(u => { patchById[u.cr_reg_id] = u.patch; });
    updateWhere_('CR_Registrations',
      r => !!patchById[r.cr_reg_id],
      r => Object.assign(r, patchById[r.cr_reg_id]));
  }

  // Auto-create leagues for any event_name not yet in the Leagues table.
  const leagueSync = syncLeaguesFromStaging_();

  crLogSync_({
    kind:    'pull_to_staging',
    method:  'GET',
    path:    filters.path || (CR_API_PREFIX + '/eventregistrationreport/listactive'),
    http_status: 200,
    count:   regs.length,
    status:  'ok',
    message: 'raw=' + regsRaw.length + ' deduped=' + regs.length + ' added=' + toAppend.length +
             ' updated=' + updates.length + ' leagues_created=' + leagueSync.created,
  });
  audit_('cr_pull_to_staging', 'integration', 'courtreserve',
    { filters }, { added: toAppend.length, updated: updates.length, raw: regsRaw.length,
                   deduped: regs.length, leagues_created: leagueSync.created });

  return {
    added:            toAppend.length,
    updated:          updates.length,
    total:            regs.length,
    raw:              regsRaw.length,
    leagues_created:  leagueSync.created,
    leagues_existing: leagueSync.existing,
  };
}

/** Wipe the entire CR_Registrations staging table (preserves header row). */
function clearStagedRegistrations_() {
  overwriteObjects_('CR_Registrations', []);
  audit_('cr_clear_staging', 'integration', 'courtreserve', null, { cleared: true });
  return { cleared: true };
}

/** Return all staged registrations, newest-first. */
function listStagedRegistrations_(opts) {
  opts = opts || {};
  const rows = getObjects_('CR_Registrations');
  rows.sort((a, b) => String(b.imported_at).localeCompare(String(a.imported_at)));
  if (opts.limit) return rows.slice(0, Number(opts.limit));
  return rows;
}

/**
 * Assign a list of staged-registration IDs to a league. For each, upsert the
 * Player by email and add to the league's Roster. For partner-format leagues,
 * the registration's first PartnersInfo entry also becomes a Player and the
 * pair forms (or joins) a Team named "LastA/LastB".
 *
 * Skips rows already assigned (assigned_league_id set).
 * Returns { assigned, skipped, errors }.
 */
function assignStagedRegistrationsToLeague_(reg_ids, league_id) {
  if (!league_id) throw new Error('Pick a target league.');
  if (!Array.isArray(reg_ids) || !reg_ids.length) throw new Error('No registrations selected.');
  const league = getLeagueById_(league_id);
  if (!league) throw new Error('League not found: ' + league_id);

  const all = getObjects_('CR_Registrations');
  const wanted = {};
  reg_ids.forEach(id => { wanted[id] = true; });
  const matching = all.filter(r => wanted[r.cr_reg_id] && !r.assigned_league_id);

  let assigned = 0, skipped = 0;
  const errors = [];

  matching.forEach(r => {
    try {
      if (!r.email && !r.first_name && !r.last_name) { skipped++; return; }
      const player = upsertPlayer_({
        full_name:      ((r.first_name || '') + ' ' + (r.last_name || '')).trim(),
        first_name:     r.first_name,
        last_name:      r.last_name,
        email:          r.email,
        phone:          r.phone,
        club_member_id: r.cr_member_id,
      });

      let team_id = '';
      let partners = [];
      try { partners = JSON.parse(r.partners_json || '[]') || []; } catch (e) { partners = []; }
      if (league.format_type === 'partner' && partners.length) {
        const partner = partners[0];
        const partnerPlayer = upsertPlayer_({
          full_name:      ((partner.FirstName || '') + ' ' + (partner.LastName || '')).trim(),
          first_name:     partner.FirstName,
          last_name:      partner.LastName,
          club_member_id: partner.OrganizationMemberId ? String(partner.OrganizationMemberId) : '',
        });
        const team_name = ((r.last_name || r.first_name || 'A') + '/' +
                           (partner.LastName || partner.FirstName || 'B')).trim();
        team_id = slotIntoTeam_(league_id, team_name, player.player_id);
        slotIntoTeam_(league_id, team_name, partnerPlayer.player_id);
        addToRoster_(league_id, partnerPlayer.player_id, { team_id });
      }
      addToRoster_(league_id, player.player_id, { team_id });

      updateWhere_('CR_Registrations',
        x => x.cr_reg_id === r.cr_reg_id,
        x => {
          x.assigned_league_id = league_id;
          x.assigned_team_id   = team_id;
          x.assigned_player_id = player.player_id;
          x.assigned_at        = nowStamp_();
        });
      assigned++;
    } catch (e) {
      errors.push((r.email || ((r.first_name||'') + ' ' + (r.last_name||''))) + ': ' + (e && e.message || e));
    }
  });

  audit_('cr_assign_staged', 'league', league_id,
    { reg_ids_count: reg_ids.length },
    { assigned, skipped, errors: errors.length });
  crLogSync_({
    kind:    'assign_staged',
    method:  '',
    path:    'league=' + league_id,
    http_status: '',
    count:   assigned,
    status:  errors.length ? 'error' : 'ok',
    message: errors.length ? errors.slice(0, 3).join(' | ') : '',
  });
  return { assigned, skipped, total: matching.length, errors };
}

/* =========================================================================
 * Sync leagues from CR staging data
 * ========================================================================= */

/**
 * For each unique event_name in CR_Registrations that doesn't already have a
 * matching league (matched by name, case-insensitive), create a new league
 * with format_type and day_of_week auto-detected from the event name.
 * Returns { created, existing, map: { event_name → league_id } }.
 */
function syncLeaguesFromStaging_() {
  const staged  = getObjects_('CR_Registrations');
  const leagues = getObjects_('Leagues');

  // name (lower) → league_id
  const byName = {};
  leagues.forEach(l => { byName[(l.name || '').trim().toLowerCase()] = l.league_id; });

  // Collect unique event_names from staging
  const eventNames = {};
  staged.forEach(r => {
    const n = (r.event_name || '').trim();
    if (n) eventNames[n] = true;
  });

  const stamp  = nowStamp_();
  const me     = activeUserEmail_();
  const result = { created: 0, existing: 0, map: {} };

  Object.keys(eventNames).sort().forEach(eventName => {
    const key = eventName.toLowerCase();
    if (byName[key]) {
      result.existing++;
      result.map[eventName] = byName[key];
      return;
    }
    const league_id   = makeId_('league');
    const format_type = _crDetectFormat_(eventName);
    const day_of_week = _crDetectDay_(eventName);
    const level       = _crDetectLevel_(eventName);

    appendObjects_('Leagues', [{
      league_id,
      name:              eventName,
      full_name:         eventName,
      format_type,
      day_of_week,
      start_time:        '',
      level,
      season_label:      '',
      weeks_count:       10,
      num_groups:        '',
      bonus_starts_week: 3,
      status:            'active',
      created_at:        stamp,
      created_by:        me,
    }]);

    byName[key]          = league_id;
    result.map[eventName] = league_id;
    result.created++;
    audit_('league_create', 'league', league_id, null,
           { name: eventName, format_type, source: 'cr_sync' });
  });

  return result;
}

/** Detect ladder vs partner from event name. */
function _crDetectFormat_(name) {
  return /partner/i.test(name || '') ? 'partner' : 'ladder';
}

/** Detect day-of-week abbreviation from event name (e.g. "Tue Coed…" → "Tuesday"). */
function _crDetectDay_(name) {
  const n = name || '';
  if (/\bmon(day)?\b/i.test(n)) return 'Monday';
  if (/\btue(s(day)?)?\b/i.test(n)) return 'Tuesday';
  if (/\bwed(nesday)?\b/i.test(n)) return 'Wednesday';
  if (/\bthu(r(s(day)?)?)?\b/i.test(n)) return 'Thursday';
  if (/\bfri(day)?\b/i.test(n)) return 'Friday';
  if (/\bsat(urday)?\b/i.test(n)) return 'Saturday';
  if (/\bsun(day)?\b/i.test(n)) return 'Sunday';
  return '';
}

/** Extract level text from parentheses, e.g. "(Levels 4-6)" → "Levels 4-6". */
function _crDetectLevel_(name) {
  const m = (name || '').match(/\(([^)]+)\)/);
  return m ? m[1] : '';
}

/**
 * Assign every unassigned staged row to the league matching its event_name.
 * Creates players + roster entries. Skips rows already assigned.
 * Returns { assigned, skipped, errors }.
 */
function autoAssignStagedByEventName_() {
  const leagueSync = syncLeaguesFromStaging_();
  const staged     = getObjects_('CR_Registrations');
  const unassigned = staged.filter(r =>
    !r.assigned_league_id &&
    r.event_name &&
    leagueSync.map[(r.event_name || '').trim()]
  );

  // Group by league_id
  const byLeague = {};
  unassigned.forEach(r => {
    const lid = leagueSync.map[(r.event_name || '').trim()];
    if (!byLeague[lid]) byLeague[lid] = [];
    byLeague[lid].push(r.cr_reg_id);
  });

  let totalAssigned = 0, totalSkipped = 0;
  const allErrors = [];

  Object.keys(byLeague).forEach(lid => {
    try {
      const res = assignStagedRegistrationsToLeague_(byLeague[lid], lid);
      totalAssigned += res.assigned || 0;
      totalSkipped  += res.skipped  || 0;
      if (res.errors && res.errors.length) allErrors.push.apply(allErrors, res.errors);
    } catch (e) {
      allErrors.push('league ' + lid + ': ' + (e && e.message || e));
    }
  });

  return {
    assigned: totalAssigned,
    skipped:  totalSkipped,
    errors:   allErrors,
    total:    unassigned.length,
  };
}

/* =========================================================================
 * One-click team setup from CourtReserve
 * ========================================================================= */

/**
 * Pull CR registrations for a wide date window, find those matching this
 * league's event_name, and create players + teams from each registration's
 * partner info — all in one shot.
 *
 * Idempotent: re-running picks up new registrations without duplicating
 * existing players/teams. Existing assigned rows are skipped.
 *
 * Matching heuristic for league.name → event_name (case-insensitive):
 *   1. Exact match
 *   2. Substring (event_name contains league.name, or vice versa)
 *   3. Token overlap (≥3 shared significant tokens)
 *
 * @param {string} league_id
 * @param {Object} opts
 *    startDate — yyyy-MM-dd (default: today − 90 days)
 *    endDate   — yyyy-MM-dd (default: today + 180 days)
 *    eventCategoryId — override category filter
 * @returns {{ regs_pulled, regs_matched, assigned, skipped, errors,
 *             teams_total, date_range, matched_event_names }}
 */
/** Default cache freshness window for the internal staging cache. */
const CR_STAGING_FRESH_HOURS = 24;

function setupTeamsFromCR_(league_id, opts) {
  opts = opts || {};
  const league = getLeagueById_(league_id);
  if (!league) throw new Error('League not found: ' + league_id);
  if (league.format_type !== 'partner') {
    throw new Error('Auto team setup is only for partner-format leagues.');
  }

  // Staging is now an internal cache. We pull from CR only if the cache is
  // stale or empty for this league. opts.forcePull = true overrides;
  // opts.skipPull = true reads cache only.
  const targetName = (league.name || '').trim().toLowerCase();
  const targetTokens = _crTokenize_(targetName);

  let allStaged = getObjects_('CR_Registrations');
  let pullResult = { added: 0, updated: 0, total: 0, skipped: true };
  let pullDateRange = '';

  // How fresh is the cache for THIS league?
  const matchingStaged = allStaged.filter(r =>
    _crEventNameMatches_(r.event_name, targetName, targetTokens)
  );
  const newestImport = matchingStaged.reduce((acc, r) => {
    const ts = r.imported_at || '';
    return ts > acc ? ts : acc;
  }, '');
  const ageHours = newestImport ? _crAgeHours_(newestImport) : Infinity;
  const stale = ageHours > (Number(opts.maxAgeHours) || CR_STAGING_FRESH_HOURS);

  if (!opts.skipPull && (opts.forcePull || matchingStaged.length === 0 || stale)) {
    // Cache miss or stale → pull from CR.
    const tz = (typeof CONFIG !== 'undefined' && CONFIG.TIMEZONE) || 'America/New_York';
    const today = new Date();
    const fmt = d => Utilities.formatDate(d, tz, 'yyyy-MM-dd');
    const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
    let startDate = opts.startDate, endDate = opts.endDate;
    if (!startDate || !endDate) {
      try {
        const sched = getLeagueSchedule_(league_id);
        const dates = sched.map(s => s.play_date).filter(Boolean)
          .map(d => String(d).slice(0, 10)).sort();
        if (dates.length) {
          const first = new Date(dates[0] + 'T12:00:00');
          const last  = new Date(dates[dates.length - 1] + 'T12:00:00');
          startDate = startDate || fmt(addDays(first, -14));
          endDate   = endDate   || fmt(addDays(last,   14));
        }
      } catch (e) { /* fall through */ }
    }
    if (!startDate) startDate = fmt(addDays(today, -30));
    if (!endDate)   endDate   = fmt(addDays(today,  60));
    pullDateRange = startDate + ' .. ' + endDate;

    try {
      pullResult = pullRegistrationsToStaging_({
        startDate, endDate,
        eventCategoryId: opts.eventCategoryId,
      });
      pullResult.skipped = false;
      // Re-read staging after the pull.
      allStaged = getObjects_('CR_Registrations');
    } catch (e) {
      // If the pull fails (rate limit / network / no creds), continue with
      // whatever is already in staging. The caller sees `pull_error`.
      pullResult = { added: 0, updated: 0, total: 0, skipped: false, error: String(e && e.message || e) };
    }
  }

  // Now match + assign from (possibly refreshed) staging.
  const matchedNames = {};
  const matching = allStaged.filter(r => {
    if (r.assigned_league_id) return false;
    if (r.status !== 'active') return false;
    const m = _crEventNameMatches_(r.event_name, targetName, targetTokens);
    if (m) matchedNames[r.event_name] = (matchedNames[r.event_name] || 0) + 1;
    return m;
  });

  let assignResult = { assigned: 0, skipped: 0, errors: [] };
  if (matching.length) {
    assignResult = assignStagedRegistrationsToLeague_(
      matching.map(r => r.cr_reg_id), league_id);
  }

  const previouslyAssigned = allStaged.filter(r => r.assigned_league_id === league_id).length;
  const teams = listTeams_(league_id);

  audit_('cr_setup_teams', 'league', league_id, null, {
    cache_age_hours: ageHours === Infinity ? 'empty' : Math.round(ageHours * 10) / 10,
    pulled: !pullResult.skipped,
    pull_added: pullResult.added || 0,
    matched: matching.length,
    assigned: assignResult.assigned,
    previously_assigned: previouslyAssigned,
    teams_total: teams.length,
  });

  return {
    cache_age_hours:     ageHours === Infinity ? null : Math.round(ageHours * 10) / 10,
    cache_was_stale:     stale,
    pull_skipped:        !!pullResult.skipped,
    pull_error:          pullResult.error || '',
    regs_pulled:         (pullResult.added || 0) + (pullResult.updated || 0),
    regs_added:          pullResult.added   || 0,
    regs_updated:        pullResult.updated || 0,
    regs_in_staging:     allStaged.length,
    regs_matched:        matching.length + previouslyAssigned,
    regs_newly_matched:  matching.length,
    regs_previously_assigned: previouslyAssigned,
    assigned:            assignResult.assigned || 0,
    skipped:             assignResult.skipped  || 0,
    errors:              assignResult.errors   || [],
    teams_total:         teams.length,
    date_range:          pullDateRange || 'cache hit (fresh)',
    matched_event_names: Object.keys(matchedNames),
  };
}

/**
 * Wipe all roster + team data for a league and clear CR_Registrations
 * `assigned_*` fields. Then bulk-rebuild Players + Teams + Rosters from
 * matching CR_Registrations rows in a single pass.
 *
 * The bulk path keeps everything in memory and does one append per table at
 * the end — orders of magnitude faster than the per-row helpers when
 * processing 20+ registrations.
 */
function resetAndResyncLeagueFromCR_(league_id) {
  const league = getLeagueById_(league_id);
  if (!league) throw new Error('League not found: ' + league_id);

  // 1. Drop Rosters for this league.
  const rosters    = getObjects_('Rosters');
  const rosterKeep = rosters.filter(r => r.league_id !== league_id);
  const rosterDropped = rosters.length - rosterKeep.length;
  overwriteObjects_('Rosters', rosterKeep);

  // 2. Drop Teams for this league.
  const teams      = getObjects_('Teams');
  const teamsKeep  = teams.filter(t => t.league_id !== league_id);
  const teamsDropped = teams.length - teamsKeep.length;
  overwriteObjects_('Teams', teamsKeep);

  // 3. Clear assigned_* fields on CR_Registrations rows pointing at this league.
  let unassigned = 0;
  updateWhere_('CR_Registrations',
    r => r.assigned_league_id === league_id,
    r => {
      r.assigned_league_id = '';
      r.assigned_team_id   = '';
      r.assigned_player_id = '';
      r.assigned_at        = '';
      unassigned++;
    });

  audit_('league_reset_roster', 'league', league_id, null, {
    rosters_dropped: rosterDropped,
    teams_dropped:   teamsDropped,
    cr_unassigned:   unassigned,
  });

  // 4. Bulk rebuild from matching CR registrations.
  const result = bulkRebuildLeagueFromCR_(league);
  return {
    reset: {
      rosters_dropped: rosterDropped,
      teams_dropped:   teamsDropped,
      cr_unassigned:   unassigned,
    },
    regs_newly_matched: result.matched,
    assigned:           result.players_added + result.players_existing,
    teams_total:        result.teams_added,
    new_players_created: result.players_added,
    matched_event_names: result.matched_event_names,
  };
}

/**
 * Bulk-rebuild a league's Players + Teams + Rosters from matching
 * CR_Registrations rows. Pure-memory work + single bulk append per table.
 */
function bulkRebuildLeagueFromCR_(league) {
  const league_id = league.league_id;
  const targetName = (league.name || '').trim().toLowerCase();
  const stamp = nowStamp_();
  const me = activeUserEmail_();

  // Read source data ONCE.
  const allRegs = getObjects_('CR_Registrations');
  const matching = allRegs.filter(r =>
    !r.assigned_league_id &&
    r.status === 'active' &&
    _crEventNameMatches_(r.event_name, targetName)
  );

  const matchedNames = {};
  matching.forEach(r => { matchedNames[r.event_name] = (matchedNames[r.event_name] || 0) + 1; });

  // Index existing Players by email so we can dedupe across the entire
  // master list (a player may already exist from another league).
  const allPlayers = getObjects_('Players');
  const playerByEmail = {};
  allPlayers.forEach(p => {
    const e = (p.email || '').toLowerCase().trim();
    if (e) playerByEmail[e] = p;
  });

  const newPlayers = [];          // to append at end
  const newTeams   = [];          // to append at end
  const newRosters = [];          // to append at end
  const teamsByName = {};         // local cache (this league's brand-new teams)
  const rosteredPlayerIds = {};   // dedupe roster entries
  const regAssignments = {};      // cr_reg_id -> { team_id, player_id }
  let playersAddedCount = 0;
  let playersExistingCount = 0;

  function ensurePlayer(input) {
    const email = (input.email || '').toLowerCase().trim();
    if (email && playerByEmail[email]) {
      // Existing player — update club_member_id if missing.
      const existing = playerByEmail[email];
      // (We don't write back updates here to keep this purely additive; the
      //  next CR pull will refresh fields via upsertPlayer_ if needed.)
      playersExistingCount++;
      return existing;
    }
    const fullName = (input.full_name ||
      ((input.first_name || '') + ' ' + (input.last_name || ''))).trim();
    const player = {
      player_id:      makeId_('player'),
      full_name:      fullName,
      first_name:     input.first_name || (fullName.split(/\s+/)[0] || ''),
      last_name:      input.last_name  || (fullName.split(/\s+/).slice(1).join(' ') || ''),
      email:          email,
      phone:          input.phone || '',
      gender:         '',
      dupr_id:        '',
      club_member_id: input.club_member_id || '',
      level:          '',
      active:         true,
      notes:          '',
      created_at:     stamp,
    };
    if (email) playerByEmail[email] = player;
    newPlayers.push(player);
    playersAddedCount++;
    return player;
  }

  function ensureTeam(name, pid1, pid2) {
    const key = name.toLowerCase();
    if (teamsByName[key]) {
      const t = teamsByName[key];
      // Slot in any missing players (a partner-of-X reg can complete an X-of-partner team).
      if (pid1 && !t.player_1_id && t.player_2_id !== pid1) t.player_1_id = pid1;
      else if (pid1 && !t.player_2_id && t.player_1_id !== pid1) t.player_2_id = pid1;
      if (pid2 && !t.player_1_id && t.player_2_id !== pid2) t.player_1_id = pid2;
      else if (pid2 && !t.player_2_id && t.player_1_id !== pid2) t.player_2_id = pid2;
      return t;
    }
    const team = {
      team_id:     makeId_('team'),
      league_id:   league_id,
      team_name:   name,
      player_1_id: pid1 || '',
      player_2_id: pid2 || '',
      created_at:  stamp,
    };
    teamsByName[key] = team;
    newTeams.push(team);
    return team;
  }

  function ensureRoster(player_id, team_id) {
    if (!player_id || rosteredPlayerIds[player_id]) return;
    rosteredPlayerIds[player_id] = true;
    newRosters.push({
      roster_id: makeId_('roster'),
      league_id: league_id,
      player_id: player_id,
      team_id:   team_id || '',
      level:     '',
      status:    'active',
      added_at:  stamp,
      added_by:  me,
    });
  }

  matching.forEach(r => {
    if (!r.email && !r.first_name && !r.last_name) return;
    const player = ensurePlayer({
      full_name:      ((r.first_name || '') + ' ' + (r.last_name || '')).trim(),
      first_name:     r.first_name,
      last_name:      r.last_name,
      email:          r.email,
      phone:          r.phone,
      club_member_id: r.cr_member_id,
    });
    let team_id = '';
    let partners = [];
    try { partners = JSON.parse(r.partners_json || '[]') || []; } catch (e) { partners = []; }
    if (league.format_type === 'partner' && partners.length) {
      const partner = partners[0];
      const partnerPlayer = ensurePlayer({
        full_name:      ((partner.FirstName || '') + ' ' + (partner.LastName || '')).trim(),
        first_name:     partner.FirstName,
        last_name:      partner.LastName,
        club_member_id: partner.OrganizationMemberId ? String(partner.OrganizationMemberId) : '',
      });
      const team_name = ((r.last_name || r.first_name || 'A') + '/' +
                         (partner.LastName || partner.FirstName || 'B')).trim();
      const team = ensureTeam(team_name, player.player_id, partnerPlayer.player_id);
      team_id = team.team_id;
      ensureRoster(partnerPlayer.player_id, team_id);
    }
    ensureRoster(player.player_id, team_id);
    regAssignments[r.cr_reg_id] = {
      assigned_league_id: league_id,
      assigned_team_id:   team_id,
      assigned_player_id: player.player_id,
      assigned_at:        stamp,
    };
  });

  // Bulk writes — one append per table.
  if (newPlayers.length) appendObjects_('Players', newPlayers);
  if (newTeams.length)   appendObjects_('Teams',   newTeams);
  if (newRosters.length) appendObjects_('Rosters', newRosters);
  cacheBust_('league:' + league_id + ':full');

  // Single batched update on CR_Registrations for assigned_* fields.
  if (Object.keys(regAssignments).length) {
    updateWhere_('CR_Registrations',
      r => !!regAssignments[r.cr_reg_id],
      r => {
        const u = regAssignments[r.cr_reg_id];
        r.assigned_league_id = u.assigned_league_id;
        r.assigned_team_id   = u.assigned_team_id;
        r.assigned_player_id = u.assigned_player_id;
        r.assigned_at        = u.assigned_at;
      });
  }

  audit_('cr_bulk_rebuild', 'league', league_id, null, {
    matched: matching.length,
    players_added: playersAddedCount,
    players_existing: playersExistingCount,
    teams_added: newTeams.length,
    rosters_added: newRosters.length,
  });

  return {
    matched:             matching.length,
    players_added:       playersAddedCount,
    players_existing:    playersExistingCount,
    teams_added:         newTeams.length,
    rosters_added:       newRosters.length,
    matched_event_names: Object.keys(matchedNames),
  };
}

/**
 * Pure-filter view of CR_Registrations for a league. No materialization.
 *
 * Returns one entry per registration that matches the league's event name
 * (strict matcher). Each entry includes the registrant, the partner (if
 * any), a computed team_name, and the resolved DUPR IDs from
 * Player_DUPR_Overrides — so the Players tab can render directly from this
 * without touching Players/Rosters/Teams.
 */
function listLeaguePlayersFromCR_(league_id) {
  const league = getLeagueById_(league_id);
  if (!league) throw new Error('League not found: ' + league_id);
  const targetName = (league.name || '').trim().toLowerCase();

  // ATTENDANCE-DRIVEN: read CR_Attendance, filter to full-event registration
  // type, dedupe by member_number, match event name.
  // CR uses "Full" (or sometimes "Full Event" / "Full Season") for full-event
  // registrations and "Drop In" / "Drop-In" / "Single Session" for drop-ins.
  // Match anything starting with "full" (case-insensitive) and explicitly
  // exclude drop-in / single-session.
  const isFullEventType = (t) => {
    const s = String(t || '').trim().toLowerCase();
    if (!s) return false;
    if (/drop[\s-]*in|single[\s-]*session|guest|trial/.test(s)) return false;
    return /^full\b|^season\b|^league\b/.test(s);
  };
  const allAttendance = getObjects_('CR_Attendance');
  const matchingAttend = allAttendance.filter(a =>
    _crEventNameMatches_(a.event_name, targetName) &&
    isFullEventType(a.registration_type)
  );

  // Dedupe by member_number — one player can have many sessions.
  const byMember = {};
  matchingAttend.forEach(a => {
    const m = String(a.member_number || '').trim();
    if (!m) return;
    if (!byMember[m]) {
      byMember[m] = {
        member_number: m,
        first_name:    a.first_name || '',
        last_name:     a.last_name  || '',
        event_name:    a.event_name || '',
      };
    }
  });
  const uniqueAttend = Object.keys(byMember).map(k => byMember[k]);

  // Use the legacy CR_Registrations rows (if any) as fallback only when
  // attendance has nothing matching at all — keeps backward compatibility.
  const allRows = getObjects_('CR_Registrations');
  const allRegs = allRows.filter(r => r.status !== 'cancelled');
  const regs = uniqueAttend.length
    ? []
    : allRegs.filter(r => _crEventNameMatches_(r.event_name, targetName));

  // Pull team pairings for this league. Each pairing maps two member_ids
  // to a single team. Used to group the attendance entries. Sheet may not
  // exist yet on a fresh install — treat as empty in that case.
  let pairings = [];
  try { pairings = getObjects_('Team_Pairings').filter(p => p.league_id === league_id); }
  catch (e) { pairings = []; }
  const pairingByMember = {};
  pairings.forEach(p => {
    if (p.p1_member_id) pairingByMember[String(p.p1_member_id)] = p;
    if (p.p2_member_id) pairingByMember[String(p.p2_member_id)] = p;
  });

  // ATTENDANCE-DRIVEN BRANCH: build rows from unique attendance entries.
  if (uniqueAttend.length) {
    // Resolve DUPR overrides + team-name overrides. Override sheets may not
    // exist on fresh installs — treat as empty.
    const duprByKey = {};
    try {
      getObjects_('Player_DUPR_Overrides').forEach(o => {
        if (o.cr_member_id) duprByKey['m:' + String(o.cr_member_id)] = o.dupr_id || '';
        if (o.email)        duprByKey['e:' + String(o.email).toLowerCase().trim()] = o.dupr_id || '';
      });
    } catch (e) { /* sheet missing — fine */ }
    function resolveDupr(member_id, email) {
      if (member_id && duprByKey['m:' + String(member_id)] != null) return duprByKey['m:' + String(member_id)];
      const e = (email || '').toLowerCase().trim();
      if (e && duprByKey['e:' + e] != null) return duprByKey['e:' + e];
      return '';
    }
    // Build a map member_id → attendance entry for partner lookup.
    const attendByMember = {};
    uniqueAttend.forEach(a => { attendByMember[String(a.member_number)] = a; });

    const aRows = uniqueAttend.map(a => {
      const memberId = String(a.member_number);
      const pairing = pairingByMember[memberId];
      let partnerMemberId = '';
      let partnerName     = '';
      let pairingId       = '';
      let teamName        = '';
      if (pairing) {
        pairingId = pairing.pairing_id;
        teamName  = pairing.team_name || '';
        partnerMemberId = String(pairing.p1_member_id) === memberId
          ? String(pairing.p2_member_id || '')
          : String(pairing.p1_member_id || '');
        const partnerEntry = partnerMemberId ? attendByMember[partnerMemberId] : null;
        if (partnerEntry) {
          partnerName = ((partnerEntry.first_name || '') + ' ' + (partnerEntry.last_name || '')).trim();
        } else if (partnerMemberId) {
          partnerName = '(partner not in attendance — id ' + partnerMemberId + ')';
        }
      }
      return {
        cr_reg_id:            'att:' + memberId,
        event_name:           a.event_name,
        registrant_name:      ((a.first_name || '') + ' ' + (a.last_name || '')).trim(),
        registrant_first:     a.first_name || '',
        registrant_last:      a.last_name  || '',
        registrant_email:     '',
        registrant_phone:     '',
        registrant_member_id: memberId,
        registrant_dupr_id:   resolveDupr(memberId, ''),
        partner_name:         partnerName,
        partner_member_id:    partnerMemberId,
        partner_dupr_id:      partnerMemberId ? resolveDupr(partnerMemberId, '') : '',
        team_name:            teamName,
        team_name_overridden: !!teamName,
        pairing_id:           pairingId,
        level:                '',
        signed_up_on:         '',
        registration_type:    'Full Event',
      };
    });
    return {
      _no_match: false,
      league_name: league.name,
      rows: aRows,
      registration_types: [{ type: 'Full Event', count: aRows.length }],
      source: 'attendance',
      pairings_count: pairings.length,
    };
  }

  // Build diagnostics for the no-match case so the UI can help debug.
  if (!regs.length) {
    const statusBreakdown = {};
    allRows.forEach(r => {
      const s = r.status || '(blank)';
      statusBreakdown[s] = (statusBreakdown[s] || 0) + 1;
    });
    const eventNamesSeen = {};
    allRows.forEach(r => {
      const n = r.event_name || '(blank)';
      eventNamesSeen[n] = (eventNamesSeen[n] || 0) + 1;
    });
    // Also surface attendance event names + reg types so we know what's there.
    const attEvents = {};
    const attTypes  = {};
    allAttendance.forEach(a => {
      const e = a.event_name || '(blank)';
      const t = a.registration_type || '(blank)';
      attEvents[e] = (attEvents[e] || 0) + 1;
      attTypes[t]  = (attTypes[t]  || 0) + 1;
    });
    const top = Object.keys(eventNamesSeen)
      .sort((a, b) => eventNamesSeen[b] - eventNamesSeen[a])
      .slice(0, 25)
      .map(n => ({ event_name: n, count: eventNamesSeen[n] }));
    const topAttEvents = Object.keys(attEvents)
      .sort((a, b) => attEvents[b] - attEvents[a])
      .slice(0, 25)
      .map(n => ({ event_name: n, count: attEvents[n] }));
    return {
      _no_match: true,
      league_name: league.name,
      total_rows: allRows.length,
      total_active_regs: allRegs.length,
      status_breakdown: statusBreakdown,
      event_names_seen: top,
      attendance_total: allAttendance.length,
      attendance_event_names: topAttEvents,
      attendance_types:        Object.keys(attTypes).map(t => ({ type: t, count: attTypes[t] })),
      rows: [],
    };
  }

  // Build override lookup tables.
  const duprByKey = {};   // cr_member_id OR lowercased email → dupr_id
  getObjects_('Player_DUPR_Overrides').forEach(o => {
    if (o.cr_member_id) duprByKey['m:' + String(o.cr_member_id)] = o.dupr_id || '';
    if (o.email)        duprByKey['e:' + String(o.email).toLowerCase().trim()] = o.dupr_id || '';
  });
  const teamNamesByReg = {};
  getObjects_('Team_Name_Overrides').forEach(o => {
    teamNamesByReg[o.cr_reg_id] = o.team_name || '';
  });

  function resolveDupr(member_id, email) {
    if (member_id && duprByKey['m:' + String(member_id)] != null) return duprByKey['m:' + String(member_id)];
    const e = (email || '').toLowerCase().trim();
    if (e && duprByKey['e:' + e] != null) return duprByKey['e:' + e];
    return '';
  }

  const rows = regs.map(r => {
    let partners = [];
    try { partners = JSON.parse(r.partners_json || '[]') || []; } catch (e) { partners = []; }
    const partner = partners.length ? partners[0] : null;
    const partnerMemberId = partner && partner.OrganizationMemberId
      ? String(partner.OrganizationMemberId) : '';
    const partnerName = partner
      ? ((partner.FirstName || '') + ' ' + (partner.LastName || '')).trim()
      : '';
    const defaultTeamName = partner
      ? ((r.last_name || r.first_name || 'A') + '/' +
         (partner.LastName || partner.FirstName || 'B')).trim()
      : '';
    const teamName = teamNamesByReg[r.cr_reg_id] || defaultTeamName;
    return {
      cr_reg_id:           r.cr_reg_id,
      event_name:          r.event_name,
      registrant_name:     ((r.first_name || '') + ' ' + (r.last_name || '')).trim(),
      registrant_email:    r.email || '',
      registrant_phone:    r.phone || '',
      registrant_member_id: r.cr_member_id || '',
      registrant_dupr_id:  resolveDupr(r.cr_member_id, r.email),
      partner_name:        partnerName,
      partner_member_id:   partnerMemberId,
      partner_dupr_id:     partner ? resolveDupr(partnerMemberId, '') : '',
      team_name:           teamName,
      team_name_overridden: !!teamNamesByReg[r.cr_reg_id],
      level:               (r.user_defined_fields_json || '').match(/Level\s*\d+/i) ? r.user_defined_fields_json.match(/Level\s*\d+/i)[0] : '',
      signed_up_on:        r.signed_up_on || '',
      registration_type:   r.registration_type || '',
    };
  });
  // Also report the distinct registration_types seen so the UI can offer a filter.
  const typesSeen = {};
  regs.forEach(r => {
    const t = r.registration_type || '(blank)';
    typesSeen[t] = (typesSeen[t] || 0) + 1;
  });
  return {
    _no_match: false,
    league_name: league.name,
    rows: rows,
    registration_types: Object.keys(typesSeen).map(t => ({ type: t, count: typesSeen[t] })),
  };
}

/**
 * Upsert a Player_DUPR_Overrides row. Either cr_member_id or email must be
 * provided (both is fine — we key by member_id when present).
 */
function setPlayerDuprOverride_(input) {
  const memberId = input.cr_member_id ? String(input.cr_member_id) : '';
  const email    = (input.email || '').toLowerCase().trim();
  if (!memberId && !email) throw new Error('cr_member_id or email required');
  const key = memberId ? ('m:' + memberId) : ('e:' + email);
  const dupr = (input.dupr_id || '').trim();
  const stamp = nowStamp_();
  const me = activeUserEmail_();

  const existing = getObjects_('Player_DUPR_Overrides').find(o => o.key === key);
  if (existing) {
    updateWhere_('Player_DUPR_Overrides', o => o.key === key, o => {
      o.dupr_id    = dupr;
      o.updated_at = stamp;
      o.updated_by = me;
      // Keep both keys in sync if we have them.
      if (memberId && !o.cr_member_id) o.cr_member_id = memberId;
      if (email    && !o.email)         o.email = email;
    });
  } else {
    appendObjects_('Player_DUPR_Overrides', [{
      key, cr_member_id: memberId, email, dupr_id: dupr,
      updated_at: stamp, updated_by: me,
    }]);
  }
  audit_('dupr_override_set', 'player', key, null, { dupr_id: dupr });
  return { key, dupr_id: dupr };
}

/** Upsert a Team_Name_Overrides row by cr_reg_id. */
function setTeamNameOverride_(cr_reg_id, team_name) {
  if (!cr_reg_id) throw new Error('cr_reg_id required');
  const name = String(team_name || '').trim();
  const stamp = nowStamp_();
  const me = activeUserEmail_();

  const existing = getObjects_('Team_Name_Overrides').find(o => o.cr_reg_id === cr_reg_id);
  if (!name) {
    // Empty name = remove override.
    if (existing) {
      const all = getObjects_('Team_Name_Overrides').filter(o => o.cr_reg_id !== cr_reg_id);
      overwriteObjects_('Team_Name_Overrides', all);
    }
    return { cr_reg_id, team_name: '' };
  }
  if (existing) {
    updateWhere_('Team_Name_Overrides', o => o.cr_reg_id === cr_reg_id, o => {
      o.team_name  = name;
      o.updated_at = stamp;
      o.updated_by = me;
    });
  } else {
    appendObjects_('Team_Name_Overrides', [{
      cr_reg_id, team_name: name, updated_at: stamp, updated_by: me,
    }]);
  }
  audit_('team_name_override_set', 'reg', cr_reg_id, null, { team_name: name });
  return { cr_reg_id, team_name: name };
}

/**
 * Materialize Team_Pairings (member_id-keyed) into Teams + Players rows that
 * the schedule generator and standings code expect. Idempotent: existing
 * Teams keyed by pairing_id are updated in-place (name only); missing ones
 * are created. Players are auto-created from CR_Attendance when not present
 * by `club_member_id`.
 *
 * Call at the start of any operation that needs a stable team_id (schedule
 * generation, standings calc, etc.).
 *
 * @returns {{ teams_added, teams_updated, players_added }}
 */
/**
 * Ensure Rosters has a row for every Teams.player_1_id / player_2_id in this
 * league. Idempotent. Useful for partner leagues built via any path
 * (Team_Pairings, assignStagedRegistrationsToLeague_, manual Sheet edits).
 *
 * @returns {{ rosters_added: number }}
 */
function syncPartnerRosterFromTeams_(league_id) {
  const teams = getObjects_('Teams').filter(t => t.league_id === league_id);
  if (!teams.length) return { rosters_added: 0 };
  const haveRoster = {};
  getObjects_('Rosters').forEach(r => {
    if (r.league_id === league_id && r.player_id) haveRoster[r.player_id] = true;
  });
  const stamp = nowStamp_();
  const me = activeUserEmail_();
  const newRosters = [];
  teams.forEach(t => {
    [t.player_1_id, t.player_2_id].forEach(pid => {
      if (!pid || haveRoster[pid]) return;
      newRosters.push({
        roster_id: makeId_('roster'),
        league_id: league_id,
        player_id: pid,
        team_id:   t.team_id,
        level:     '',
        status:    'active',
        added_at:  stamp,
        added_by:  me,
      });
      haveRoster[pid] = true;
    });
  });
  if (newRosters.length) {
    appendObjects_('Rosters', newRosters);
    cacheBust_('league:' + league_id + ':full');
    audit_('partner_roster_sync_from_teams', 'league', league_id, null,
      { rosters_added: newRosters.length });
  }
  return { rosters_added: newRosters.length };
}

function materializePairingsToTeams_(league_id) {
  const pairings = getObjects_('Team_Pairings').filter(p => p.league_id === league_id);
  if (!pairings.length) return { teams_added: 0, teams_updated: 0, players_added: 0, rosters_added: 0 };

  const existingTeams = getObjects_('Teams');
  const teamByTeamId = {};
  existingTeams.forEach(t => { if (t.team_id) teamByTeamId[t.team_id] = t; });

  const existingPlayers = getObjects_('Players');
  const playerByMember = {};
  existingPlayers.forEach(p => {
    if (p.club_member_id) playerByMember[String(p.club_member_id)] = p;
  });

  const attendance = getObjects_('CR_Attendance');
  const attByMember = {};
  attendance.forEach(a => {
    const m = String(a.member_number || '');
    if (!m || attByMember[m]) return;
    attByMember[m] = a;
  });

  const stamp = nowStamp_();
  const newPlayers = [];
  const newTeams   = [];
  const teamUpdates = [];

  function ensurePlayer(memberId) {
    if (!memberId) return null;
    const m = String(memberId);
    if (playerByMember[m]) return playerByMember[m];
    const att = attByMember[m];
    const fullName = att
      ? ((att.first_name || '') + ' ' + (att.last_name || '')).trim()
      : '(member ' + m + ')';
    const player = {
      player_id:      makeId_('player'),
      full_name:      fullName || ('(member ' + m + ')'),
      first_name:     att ? (att.first_name || '') : '',
      last_name:      att ? (att.last_name  || '') : '',
      email:          '',
      phone:          '',
      gender:         '',
      dupr_id:        '',
      club_member_id: m,
      level:          '',
      active:         true,
      notes:          'auto from Team_Pairings',
      created_at:     stamp,
    };
    playerByMember[m] = player;
    newPlayers.push(player);
    return player;
  }

  pairings.forEach(p => {
    const p1 = ensurePlayer(p.p1_member_id);
    const p2 = ensurePlayer(p.p2_member_id);
    const existing = teamByTeamId[p.pairing_id];
    if (existing) {
      // Update in place if anything changed.
      if (existing.team_name !== p.team_name ||
          existing.player_1_id !== (p1 && p1.player_id) ||
          existing.player_2_id !== (p2 && p2.player_id)) {
        teamUpdates.push({
          team_id: p.pairing_id,
          patch: {
            team_name:   p.team_name || existing.team_name,
            player_1_id: (p1 && p1.player_id) || existing.player_1_id || '',
            player_2_id: (p2 && p2.player_id) || existing.player_2_id || '',
          },
        });
      }
    } else {
      newTeams.push({
        team_id:     p.pairing_id,
        league_id:   league_id,
        team_name:   p.team_name || '',
        player_1_id: (p1 && p1.player_id) || '',
        player_2_id: (p2 && p2.player_id) || '',
        created_at:  stamp,
      });
    }
  });

  if (newPlayers.length) appendObjects_('Players', newPlayers);
  if (newTeams.length)   appendObjects_('Teams',   newTeams);
  teamUpdates.forEach(u => {
    updateWhere_('Teams',
      t => t.team_id === u.team_id,
      t => Object.assign(t, u.patch));
  });

  // Also ensure Rosters has an entry for every team's player_1_id / player_2_id.
  // Without this, getNoShowsForLeagueDate_ sees an empty roster for the league
  // and bails before classifying any attendance row.
  const allRosters = getObjects_('Rosters');
  const haveRoster = {};
  allRosters.forEach(r => {
    if (r.league_id === league_id && r.player_id) haveRoster[r.player_id] = true;
  });
  const stamp2 = nowStamp_();
  const me = activeUserEmail_();
  const newRosters = [];
  // Re-read Teams since we just appended new ones.
  const teamsAfter = getObjects_('Teams').filter(t => t.league_id === league_id);
  teamsAfter.forEach(t => {
    [t.player_1_id, t.player_2_id].forEach(pid => {
      if (!pid || haveRoster[pid]) return;
      newRosters.push({
        roster_id: makeId_('roster'),
        league_id: league_id,
        player_id: pid,
        team_id:   t.team_id,
        level:     '',
        status:    'active',
        added_at:  stamp2,
        added_by:  me,
      });
      haveRoster[pid] = true;
    });
  });
  if (newRosters.length) {
    appendObjects_('Rosters', newRosters);
    cacheBust_('league:' + league_id + ':full');
  }

  if (newTeams.length || teamUpdates.length || newPlayers.length || newRosters.length) {
    audit_('teams_materialized_from_pairings', 'league', league_id, null, {
      teams_added:    newTeams.length,
      teams_updated:  teamUpdates.length,
      players_added:  newPlayers.length,
      rosters_added:  newRosters.length,
    });
  }
  return {
    teams_added:   newTeams.length,
    teams_updated: teamUpdates.length,
    players_added: newPlayers.length,
    rosters_added: newRosters.length,
  };
}

/**
 * Create a team pairing for a league. Validates that neither member_id is
 * already paired in this league. team_name defaults to "Last1/Last2"
 * derived from CR_Attendance entries when not provided.
 */
function createTeamPairing_(input) {
  const league_id = input.league_id;
  const m1 = String(input.p1_member_id || '').trim();
  const m2 = String(input.p2_member_id || '').trim();
  if (!league_id) throw new Error('league_id required');
  if (!m1 || !m2) throw new Error('Both player member IDs required');
  if (m1 === m2)  throw new Error('Players must differ');

  const existing = getObjects_('Team_Pairings').filter(p => p.league_id === league_id);
  const taken = existing.find(p =>
    String(p.p1_member_id) === m1 || String(p.p2_member_id) === m1 ||
    String(p.p1_member_id) === m2 || String(p.p2_member_id) === m2
  );
  if (taken) throw new Error('One of these players is already paired in this league');

  let teamName = String(input.team_name || '').trim();
  if (!teamName) {
    const att = getObjects_('CR_Attendance');
    const a1 = att.find(a => String(a.member_number) === m1);
    const a2 = att.find(a => String(a.member_number) === m2);
    const last1 = (a1 && a1.last_name) || (a1 && a1.first_name) || 'A';
    const last2 = (a2 && a2.last_name) || (a2 && a2.first_name) || 'B';
    teamName = String(last1).trim() + '/' + String(last2).trim();
  }

  const row = {
    pairing_id:    makeId_('team'),
    league_id:     league_id,
    p1_member_id:  m1,
    p2_member_id:  m2,
    team_name:     teamName,
    created_at:    nowStamp_(),
    created_by:    activeUserEmail_(),
  };
  appendObjects_('Team_Pairings', [row]);
  audit_('team_pair_create', 'pairing', row.pairing_id, null,
    { league_id, m1, m2, team_name: teamName });
  return row;
}

function renameTeamPairing_(pairing_id, team_name) {
  const trimmed = String(team_name || '').trim();
  if (!trimmed) throw new Error('team_name cannot be blank');
  const before = getObjects_('Team_Pairings').find(p => p.pairing_id === pairing_id);
  if (!before) throw new Error('Pairing not found: ' + pairing_id);
  if (before.team_name === trimmed) return before;
  updateWhere_('Team_Pairings', p => p.pairing_id === pairing_id, p => { p.team_name = trimmed; });
  audit_('team_pair_rename', 'pairing', pairing_id, before.team_name, trimmed);
  return getObjects_('Team_Pairings').find(p => p.pairing_id === pairing_id);
}

function deleteTeamPairing_(pairing_id) {
  const all = getObjects_('Team_Pairings');
  const remain = all.filter(p => p.pairing_id !== pairing_id);
  if (remain.length === all.length) return { deleted: false };
  overwriteObjects_('Team_Pairings', remain);
  audit_('team_pair_delete', 'pairing', pairing_id, null, null);
  return { deleted: true };
}

/** Hours between an "yyyy-MM-dd HH:mm:ss" timestamp string and now. */
function _crAgeHours_(stamp) {
  if (!stamp) return Infinity;
  // The stamp is in CONFIG.TIMEZONE; we just need a relative diff so parsing
  // as a Date in any TZ is fine for the hour-scale comparison.
  const t = new Date(String(stamp).replace(' ', 'T'));
  if (isNaN(t.getTime())) return Infinity;
  return (Date.now() - t.getTime()) / (1000 * 60 * 60);
}

/** Normalize a league/event name so trivial differences don't break matching.
 *  - lowercase, trim
 *  - collapse whitespace
 *  - normalize smart quotes/apostrophes to ASCII
 *  - normalize all dash variants (— – −) to '-'
 *  - strip a leading "[Spring 2026] " / "[2026] " bracket-prefix tag
 *
 *  Deliberately does NOT strip leading day-of-week ("Tue ", "Wed ") or
 *  time-of-day ("8 am ") tokens — those are real differentiators when two
 *  leagues share the same body (Tue + Wed Intermediate Ladies Ladder, or
 *  8am + 9am Coed). The user must name the league to exactly match the CR
 *  event name; the no-match diagnostic surfaces the top event names so it's
 *  obvious what the right name is.
 */
function _crNormalizeName_(s) {
  if (!s) return '';
  let n = String(s).toLowerCase().trim();
  n = n.replace(/[‘’ʼ]/g, "'");      // smart single quotes
  n = n.replace(/[“”]/g, '"');             // smart double quotes
  n = n.replace(/[–—−]/g, '-');       // em / en / minus → hyphen
  n = n.replace(/^\s*\[[^\]]+\]\s*/, '');            // strip "[Spring 2026]" prefix
  n = n.replace(/\s+/g, ' ');                        // collapse whitespace
  return n;
}

/** Strict event-name match: normalized exact-only.
 *
 *  We deliberately do NOT do substring or token-overlap matching:
 *    - Token overlap caught sibling leagues ("Mixed" vs "Men's").
 *    - Substring caught past seasons of the same league (CR includes the
 *      season suffix in the event name; the league name doesn't).
 *
 *  If a league name and event name differ in any meaningful way after
 *  normalization, the user must rename the league to match the exact CR
 *  event name. The Players tab shows the top event names in CR_Registrations
 *  when there's no match, so it's obvious what the right name is.
 */
function _crEventNameMatches_(eventName, targetName /*, _unused */) {
  const en = _crNormalizeName_(eventName);
  const tn = _crNormalizeName_(targetName);
  if (!en || !tn) return false;
  return en === tn;
}

/** Tokenize a league/event name for fuzzy matching (drop short / common words). */
function _crTokenize_(name) {
  const stop = { 'and': 1, 'the': 1, 'for': 1, 'a': 1, 'an': 1, 'of': 1, '-': 1, '—': 1 };
  return String(name || '').toLowerCase()
    .replace(/[(),—\-]/g, ' ')
    .split(/\s+/)
    .filter(t => t && t.length >= 3 && !stop[t]);
}

/**
 * Unassign a staged registration (remove from league roster + clear assignment
 * fields on the staging row). Lets the user redo a misassignment without
 * polluting the league's Players. Player records themselves are NOT deleted.
 */
function unassignStagedRegistrations_(reg_ids) {
  if (!Array.isArray(reg_ids) || !reg_ids.length) return { unassigned: 0 };
  const all = getObjects_('CR_Registrations');
  const wanted = {};
  reg_ids.forEach(id => { wanted[id] = true; });
  const matching = all.filter(r => wanted[r.cr_reg_id] && r.assigned_league_id);
  let unassigned = 0;
  matching.forEach(r => {
    if (r.assigned_player_id && r.assigned_league_id) {
      removeFromRoster_(r.assigned_league_id, r.assigned_player_id);
    }
    updateWhere_('CR_Registrations',
      x => x.cr_reg_id === r.cr_reg_id,
      x => {
        x.assigned_league_id = '';
        x.assigned_team_id   = '';
        x.assigned_player_id = '';
        x.assigned_at        = '';
      });
    unassigned++;
  });
  audit_('cr_unassign_staged', 'integration', 'courtreserve',
    null, { unassigned });
  return { unassigned };
}

/* =========================================================================
 * CR Attendance (check-in / no-show)
 *
 * Endpoint: GET /api/v1/attendancereport/checkin
 * Params:   reservationStartDate / reservationEndDate  (ISO datetime, ≤31-day range)
 *           includeEvents=true  (we only want event attendance, not court bookings)
 *           includeCourtBooking=false
 *
 * Response fields stored:
 *   MemberNumber, MemberFirstName, MemberLastName,
 *   CheckinDateTime, RegistrationTypeDisplay, EventName,
 *   ReservationDateTimeDisplay, CheckInType, CheckedinByName,
 *   CheckInStatusName, IsGuest, Type,
 *   RegisteredOnDateTimeDisplay,
 *   ReservationStartDateTime, ReservationEndDateTime
 *
 * Dedup key: member_number + '|' + event_name + '|' + reservation_start (date only)
 * ========================================================================= */

function _crAttendanceDedupKey_(memberNumber, eventName, reservationStart) {
  const m = String(memberNumber || '').trim();
  const e = (eventName   || '').trim().toLowerCase();
  // reservationStart may be a Date object (Sheets auto-parses datetime strings)
  const rsv = reservationStart;
  const d = rsv
    ? (rsv instanceof Date
        ? Utilities.formatDate(rsv, CONFIG.TIMEZONE, 'yyyy-MM-dd')
        : String(rsv).replace('T', ' ').slice(0, 10))
    : '';
  return m + '|' + e + '|' + d;
}

/* =========================================================================
 * League events pull — /api/v1/eventcalendar/eventlist
 *
 * Pulls the list of events in the League category (default 48794) and
 * creates/updates Leagues rows with cr_event_id set. After this, attendance
 * can be filtered to events that match Leagues.cr_event_id directly — no
 * CR_Registrations dependency.
 * ========================================================================= */

/**
 * Hit /api/v1/eventcalendar/eventlist with the given filters. Auto-chunks the
 * date range into ≤31-day windows. Returns the raw deduped event array
 * (one row per EventId).
 */
function crListEvents_(filters) {
  filters = filters || {};
  if (!filters.startDate || !filters.endDate) {
    throw new Error('crListEvents_: startDate and endDate required.');
  }
  const chunks = crChunkDateRange_(filters.startDate, filters.endDate, 31);
  const seen = {};
  const out = [];
  chunks.forEach(pair => {
    const q = {
      startDate: pair[0],
      endDate:   pair[1],
      includeRegisteredPlayersCount: true,
      includePriceInfo:              true,
      status: 'Active',
    };
    if (filters.categoryId)  q.categoryId  = filters.categoryId;
    if (filters.categoryIds) q.categoryIds = filters.categoryIds;
    const body = crGet_(CR_API_PREFIX + '/eventcalendar/eventlist', q);
    const data = crUnwrap_(body);
    if (Array.isArray(data)) {
      data.forEach(ev => {
        if (!ev || ev.EventId == null) return;
        if (seen[ev.EventId]) return;
        seen[ev.EventId] = true;
        out.push(ev);
      });
    }
  });
  return out;
}

/**
 * Pull league events from CR and upsert them as Leagues rows.
 *
 * @param {Object} filters
 *    startDate, endDate — required (yyyy-MM-dd)
 *    categoryId — default 48794 (League)
 * @returns {{ created, updated, total, sample }}
 */
function pullLeagueEventsToLeagues_(filters) {
  filters = filters || {};
  const categoryId = filters.categoryId || '48794';
  const events = crListEvents_(Object.assign({}, filters, { categoryId }));

  const existing = getObjects_('Leagues');
  const byCrEventId = {};
  existing.forEach(l => {
    if (l.cr_event_id) byCrEventId[String(l.cr_event_id)] = l;
  });

  const stamp = nowStamp_();
  const me    = activeUserEmail_();
  let created = 0, updated = 0;

  const newRows = [];
  const sample = [];
  events.forEach(ev => {
    const evId = String(ev.EventId);
    const evName = ev.EventName || '';
    const startIso = ev.StartDateTime || '';
    const endIso   = ev.EndDateTime   || '';
    const formatType = /partner/i.test(evName) ? 'partner' : 'ladder';
    const dayOfWeek  = _crDetectDay_(evName);
    const level      = _crDetectLevel_(evName);

    if (sample.length < 5) sample.push({ EventId: ev.EventId, EventName: evName, RegisteredCount: ev.RegisteredCount });

    const prev = byCrEventId[evId];
    if (prev) {
      // Update only fields safe to overwrite (don't clobber human-edited
      // format_type, level, etc.).
      updateWhere_('Leagues',
        l => l.league_id === prev.league_id,
        l => {
          l.name           = evName || l.name;
          l.full_name      = evName || l.full_name;
          l.cr_event_id    = evId;
          l.cr_category_id = ev.EventCategoryId || l.cr_category_id || '';
          l.cr_event_start = startIso || l.cr_event_start || '';
          l.cr_event_end   = endIso || l.cr_event_end || '';
          // Refresh derived fields if they're empty.
          if (!l.day_of_week) l.day_of_week = dayOfWeek;
          if (!l.level)        l.level       = level;
          if (!l.format_type)  l.format_type = formatType;
        });
      updated++;
    } else {
      const league_id = makeId_('league');
      newRows.push({
        league_id,
        name:              evName,
        full_name:         evName,
        format_type:       formatType,
        day_of_week:       dayOfWeek,
        start_time:        '',
        level:             level,
        season_label:      '',
        weeks_count:       '',
        num_groups:        '',
        bonus_starts_week: 3,
        status:            'active',
        created_at:        stamp,
        created_by:        me,
        cr_event_id:       evId,
        cr_category_id:    String(ev.EventCategoryId || ''),
        cr_event_start:    startIso,
        cr_event_end:      endIso,
      });
      created++;
    }
  });
  if (newRows.length) appendObjects_('Leagues', newRows);
  cacheBust_('leagues:list');

  audit_('cr_pull_league_events', 'integration', 'courtreserve',
    { startDate: filters.startDate, endDate: filters.endDate, categoryId },
    { created, updated, total: events.length });
  crLogSync_({
    kind: 'pull_league_events',
    method: 'GET',
    path: CR_API_PREFIX + '/eventcalendar/eventlist',
    http_status: 200,
    count: events.length,
    status: 'ok',
    message: 'created=' + created + ' updated=' + updated,
  });

  return { created, updated, total: events.length, sample };
}

/**
 * Fetch attendance records from CR for a date range.
 * Auto-chunks into ≤31-day windows. Filters to event attendance only.
 * Returns the raw array of records.
 */
function crListAttendance_(startDate, endDate) {
  if (!startDate || !endDate) throw new Error('Need both startDate and endDate.');
  const chunks = crChunkDateRange_(startDate, endDate, 31);
  let combined = [];
  chunks.forEach(pair => {
    const q = {
      reservationStartDate: pair[0],
      reservationEndDate:   pair[1],
      includeEvents:        true,
      includeCourtBooking:  false,
    };
    const body = crGet_(CR_API_PREFIX + '/attendancereport/checkin', q);
    const data = crUnwrap_(body);
    if (Array.isArray(data)) combined = combined.concat(data);
  });
  return combined;
}

/**
 * Pull attendance from CourtReserve into CR_Attendance, filtered to event names
 * that appear in CR_Registrations (League category only).
 * Upserts on (member_number, event_name, reservation_start_date).
 * Returns { added, updated, total, raw }.
 */
function pullAttendanceToStaging_(filters) {
  filters = filters || {};
  if (!filters.startDate || !filters.endDate) {
    throw new Error('Need both startDate and endDate.');
  }
  // includeAll = keep every attendance record (full event + drop in + checked
  // in + no-show + sub-for-league). Default false: legacy behavior keeps only
  // no-shows + subs (used by the Operator's ranked-roster no-show detection).
  // Set true when populating league rosters from attendance.
  const includeAll = !!filters.includeAll;

  const rawRecords = crListAttendance_(filters.startDate, filters.endDate);

  let kept;
  if (includeAll) {
    kept = rawRecords;
  } else {
    kept = rawRecords.filter(r => {
      const s = (r.CheckInStatusName || '').toLowerCase().replace(/\s+/g, '');
      return s.indexOf('noshow') !== -1 || s.indexOf('subforleague') !== -1;
    });
  }

  // Filter to known league events. Prefer the Leagues table (when populated
  // from /eventcalendar/eventlist via pullLeagueEventsToLeagues_) so we don't
  // depend on CR_Registrations being pulled. Fall back to CR_Registrations,
  // and finally keep everything if neither source has any data.
  const knownEvents = {};
  getObjects_('Leagues').forEach(l => {
    if (l.name) knownEvents[(l.name || '').trim().toLowerCase()] = true;
  });
  if (!Object.keys(knownEvents).length) {
    getObjects_('CR_Registrations').forEach(r => {
      if (r.event_name) knownEvents[(r.event_name || '').trim().toLowerCase()] = true;
    });
  }
  const haveAnyKnown = Object.keys(knownEvents).length > 0;
  const records = haveAnyKnown
    ? kept.filter(r => knownEvents[(r.EventName || '').trim().toLowerCase()])
    : kept;

  // Pre-dedup within the batch
  const seenInBatch = {};
  const deduped = records.filter(r => {
    const k = _crAttendanceDedupKey_(r.MemberNumber, r.EventName, r.ReservationStartDateTime);
    if (seenInBatch[k]) return false;
    seenInBatch[k] = true;
    return true;
  });

  // Build index of existing rows
  const existing = getObjects_('CR_Attendance');
  const byKey = {};
  existing.forEach(r => {
    byKey[_crAttendanceDedupKey_(r.member_number, r.event_name, r.reservation_start)] = r;
  });

  const toAppend = [];
  const updates  = [];

  deduped.forEach(rec => {
    const key    = _crAttendanceDedupKey_(rec.MemberNumber, rec.EventName, rec.ReservationStartDateTime);
    const prev   = byKey[key];
    const patch  = {
      imported_at:          nowStamp_(),
      check_in_status:      rec.CheckInStatusName  || '',
      check_in_type:        rec.CheckInType        || '',
      checkin_datetime:     rec.CheckinDateTime    || '',
      checked_in_by:        rec.CheckedinByName    || '',
      reservation_display:  rec.ReservationDateTimeDisplay || '',
      registered_on_display: rec.RegisteredOnDateTimeDisplay || '',
    };
    if (prev) {
      updates.push({ attendance_id: prev.attendance_id, patch });
    } else {
      const newRow = Object.assign({
        attendance_id:        makeId_('audit'),
        member_number:        String(rec.MemberNumber    || '').trim(),
        first_name:           rec.MemberFirstName  || '',
        last_name:            rec.MemberLastName   || '',
        event_name:           rec.EventName        || '',
        registration_type:    rec.RegistrationTypeDisplay || '',
        reservation_start:    rec.ReservationStartDateTime || '',
        reservation_end:      rec.ReservationEndDateTime   || '',
        is_guest:             rec.IsGuest          || '',
        type:                 rec.Type             || '',
      }, patch);
      toAppend.push(newRow);
      byKey[key] = newRow;
    }
  });

  if (toAppend.length) appendObjects_('CR_Attendance', toAppend);
  if (updates.length) {
    const patchById = {};
    updates.forEach(u => { patchById[u.attendance_id] = u.patch; });
    updateWhere_('CR_Attendance',
      r => !!patchById[r.attendance_id],
      r => Object.assign(r, patchById[r.attendance_id]));
  }

  crLogSync_({
    kind:        'pull_attendance',
    method:      'GET',
    path:        CR_API_PREFIX + '/attendancereport/checkin',
    http_status: 200,
    count:       deduped.length,
    status:      'ok',
    message:     'raw=' + rawRecords.length + ' no_shows=' + noShows.length +
                 ' league_filtered=' + records.length + ' deduped=' + deduped.length +
                 ' added=' + toAppend.length + ' updated=' + updates.length,
  });

  return { added: toAppend.length, updated: updates.length, total: deduped.length, raw: rawRecords.length, no_shows: noShows.length };
}

/**
 * Targeted attendance pull: one league × one date.
 *
 * Hits /api/v1/attendancereport/checkin with a 24-hour reservation window and
 * (when available) the league's cr_event_id as an EventId filter. CR may or
 * may not honor the EventId param — we belt-and-suspenders filter the
 * response client-side as well, by EventId match if we have one, otherwise
 * by strict event-name match against league.name.
 *
 * Use case: operator clicks "Pull today's attendance" on the Operator page
 * the day-of-league. Cuts payload from "every event in the org for the day"
 * to just this league's records — typically a few dozen rows.
 *
 * @param {string} league_id
 * @param {string} date  yyyy-MM-dd
 * @returns {{ league_name, date, cr_event_id, raw_rows, matched_rows, added, updated }}
 */
function pullAttendanceForLeagueDate_(league_id, date) {
  const league = getLeagueById_(league_id);
  if (!league) throw new Error('League not found: ' + league_id);
  const dateStr = String(date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error('Date required (yyyy-MM-dd)');
  }
  const startIso = dateStr + 'T00:00:00Z';
  const endIso   = dateStr + 'T23:59:59Z';

  const q = {
    reservationStartDate: startIso,
    reservationEndDate:   endIso,
    includeEvents:        true,
    includeCourtBooking:  false,
  };
  // CR's param naming on this endpoint isn't fully documented and previous
  // testing showed plain `eventId` is silently ignored. Send several variants
  // — CR drops unknown params, so this is harmless and might shrink the
  // payload if any of them is honored.
  if (league.cr_event_id) {
    const eid = league.cr_event_id;
    q.eventId  = eid;
    q.eventIds = eid;
    q.EventId  = eid;
  }
  if (league.cr_category_id) {
    q.eventCategoryIds = league.cr_category_id;
  }

  const body = crGet_(CR_API_PREFIX + '/attendancereport/checkin', q);
  const data = crUnwrap_(body);
  const rawRecords = Array.isArray(data) ? data : [];

  // Client-side narrowing — even if CR honored the EventId filter, double-
  // check so we never store cross-event noise.
  const targetName = (league.name || '').trim();
  const filtered = rawRecords.filter(r => {
    if (league.cr_event_id && r.EventId != null) {
      return String(r.EventId) === String(league.cr_event_id);
    }
    return _crEventNameMatches_(r.EventName, targetName);
  });

  // Pre-dedup within the batch.
  const seenInBatch = {};
  const deduped = filtered.filter(r => {
    const k = _crAttendanceDedupKey_(r.MemberNumber, r.EventName, r.ReservationStartDateTime);
    if (seenInBatch[k]) return false;
    seenInBatch[k] = true;
    return true;
  });

  // Upsert into CR_Attendance.
  const existing = getObjects_('CR_Attendance');
  const byKey = {};
  existing.forEach(r => {
    byKey[_crAttendanceDedupKey_(r.member_number, r.event_name, r.reservation_start)] = r;
  });

  const toAppend = [];
  const updates  = [];

  deduped.forEach(rec => {
    const key   = _crAttendanceDedupKey_(rec.MemberNumber, rec.EventName, rec.ReservationStartDateTime);
    const prev  = byKey[key];
    const patch = {
      imported_at:           nowStamp_(),
      check_in_status:       rec.CheckInStatusName  || '',
      check_in_type:         rec.CheckInType        || '',
      checkin_datetime:      rec.CheckinDateTime    || '',
      checked_in_by:         rec.CheckedinByName    || '',
      reservation_display:   rec.ReservationDateTimeDisplay || '',
      registered_on_display: rec.RegisteredOnDateTimeDisplay || '',
    };
    if (prev) {
      updates.push({ attendance_id: prev.attendance_id, patch });
    } else {
      const newRow = Object.assign({
        attendance_id:     makeId_('audit'),
        member_number:     String(rec.MemberNumber || '').trim(),
        first_name:        rec.MemberFirstName || '',
        last_name:         rec.MemberLastName  || '',
        event_name:        rec.EventName       || '',
        registration_type: rec.RegistrationTypeDisplay || '',
        reservation_start: rec.ReservationStartDateTime || '',
        reservation_end:   rec.ReservationEndDateTime   || '',
        is_guest:          rec.IsGuest         || '',
        type:              rec.Type            || '',
      }, patch);
      toAppend.push(newRow);
      byKey[key] = newRow;
    }
  });

  if (toAppend.length) appendObjects_('CR_Attendance', toAppend);
  if (updates.length) {
    // Batch all updates into a single tab-wide read+write — one updateWhere_
    // call regardless of update count.
    const patchById = {};
    updates.forEach(u => { patchById[u.attendance_id] = u.patch; });
    updateWhere_('CR_Attendance',
      r => !!patchById[r.attendance_id],
      r => Object.assign(r, patchById[r.attendance_id]));
  }

  crLogSync_({
    kind:        'pull_attendance_targeted',
    method:      'GET',
    path:        CR_API_PREFIX + '/attendancereport/checkin',
    http_status: 200,
    count:       deduped.length,
    status:      'ok',
    message:     `league=${league.name} date=${dateStr} eventId=${league.cr_event_id || '(none)'} ` +
                 `raw=${rawRecords.length} matched=${filtered.length} ` +
                 `added=${toAppend.length} updated=${updates.length}`,
  });

  const result = {
    league_name:  league.name,
    date:         dateStr,
    cr_event_id:  league.cr_event_id || '',
    raw_rows:     rawRecords.length,
    matched_rows: filtered.length,
    added:        toAppend.length,
    updated:      updates.length,
  };

  // For ladder leagues, also sync the Rosters table from the freshly-pulled
  // attendance — otherwise the Operator's Setup screen still says "No players
  // on this league's roster" even though we just imported attendees.
  if (league.format_type === 'ladder') {
    try {
      const sync = syncLadderRosterFromAttendance_(league_id);
      result.roster_total          = sync.total_attendees;
      result.roster_players_added  = sync.players_added;
      result.roster_rows_added     = sync.rosters_added;
    } catch (e) {
      result.roster_error = String(e && e.message || e);
    }
  } else if (league.format_type === 'partner') {
    // For partner leagues, ensure Teams' player_ids have Roster rows so the
    // no-show / sub matcher in getNoShowsForLeagueDate_ has data to work with.
    // Run materialize first (catches any unmaterialized Team_Pairings) then
    // a generic Teams→Rosters backfill (catches teams created via older flows).
    try {
      const mat = materializePairingsToTeams_(league_id);
      const sync = syncPartnerRosterFromTeams_(league_id);
      result.teams_added   = mat.teams_added;
      result.players_added = mat.players_added;
      result.rosters_added = (mat.rosters_added || 0) + (sync.rosters_added || 0);
    } catch (e) {
      result.roster_error = String(e && e.message || e);
    }
  }
  return result;
}

/** Return all attendance records, newest reservation first. */
function listAttendance_(opts) {
  opts = opts || {};
  const rows = getObjects_('CR_Attendance');
  rows.sort((a, b) => String(b.reservation_start).localeCompare(String(a.reservation_start)));
  if (opts.limit) return rows.slice(0, Number(opts.limit));
  return rows;
}

/** Wipe the CR_Attendance table. */
function clearAttendance_() {
  overwriteObjects_('CR_Attendance', []);
  return { cleared: true };
}

/**
 * Return the player_ids of players on a league's roster who have a no-show
 * record in CR_Attendance on or near the given date. Matching uses two strategies:
 *   1. Players.club_member_id vs CR_Attendance.member_number (primary)
 *   2. Normalised first+last name vs CR_Attendance first_name+last_name (fallback)
 *
 * If date is null/empty (no schedule configured), we look back 14 days and return
 * any no-shows found — the most recent date with hits is reported back.
 *
 * @param {string} league_id
 * @param {string} date  — 'yyyy-MM-dd'; pass '' or null to search the last 14 days
 * @returns {{ player_ids: string[], date: string, roster_checked: number,
 *             members_with_id: number, matched_by_id: number, matched_by_name: number,
 *             attendance_rows_checked: number }}
 */
function getNoShowsForLeagueDate_(league_id, date) {
  const hasDate = date && String(date).trim().length >= 10;
  const dateStr = hasDate
    ? String(date).slice(0, 10)
    : null;

  // When no specific date given, search a window: past 14 days AND next 7 days.
  // Sessions in CR may be stamped with a future reservation_start (the scheduled
  // session time), so a lookback-only window misses upcoming sessions.
  const now = new Date().getTime();
  const windowStart = hasDate ? null : (now - 14 * 24 * 60 * 60 * 1000);
  const windowEnd   = hasDate ? null : (now +  7 * 24 * 60 * 60 * 1000);

  // Event-name filter: match attendance rows whose event_name matches the
  // league's name via the strict normalizer. This works for both
  // registration-assigned partner leagues AND attendance-driven ladder
  // leagues (which have no CR_Registrations.assigned_league_id rows). Falls
  // back to the CR_Registrations.assigned_league_id mapping if the league
  // record is missing for any reason.
  const leagueRow = getLeagueById_(league_id);
  const leagueName = leagueRow ? (leagueRow.name || '').trim() : '';
  const matchesLeagueEvent = (eventName) => {
    if (!eventName) return false;
    if (leagueName) return _crEventNameMatches_(eventName, leagueName);
    return false;
  };
  const hasEventFilter = !!leagueName;
  // Also collect the explicit assignment-based event names for legacy partner
  // leagues that used the registration assignment workflow — union with the
  // strict matcher so existing data still works.
  const assignedEventNames = {};
  getObjects_('CR_Registrations').forEach(r => {
    if (r.assigned_league_id === league_id && r.event_name) {
      assignedEventNames[(r.event_name || '').trim().toLowerCase()] = true;
    }
  });

  // Roster player_ids for this league
  const rosterRows = getObjects_('Rosters').filter(
    r => r.league_id === league_id && String(r.status || '') !== 'removed'
  );
  const rosterPlayerIds = rosterRows.map(r => r.player_id);
  if (!rosterPlayerIds.length) {
    return { player_ids: [], date: dateStr || '', roster_checked: 0,
             members_with_id: 0, matched_by_id: 0, matched_by_name: 0, attendance_rows_checked: 0 };
  }

  // Build lookup maps from Players
  const memberToPlayerId = {};  // club_member_id → player_id
  const nameToPlayerId   = {};  // 'firstname|lastname' → player_id
  let membersWithId = 0;
  getObjects_('Players').forEach(p => {
    if (rosterPlayerIds.indexOf(p.player_id) === -1) return;
    if (p.club_member_id) {
      memberToPlayerId[String(p.club_member_id).trim()] = p.player_id;
      membersWithId++;
    }
    // Name fallback: normalise to lowercase, strip extra spaces
    const nameKey = (String(p.first_name || '').trim().toLowerCase() + '|' +
                     String(p.last_name  || '').trim().toLowerCase());
    if (nameKey !== '|') nameToPlayerId[nameKey] = p.player_id;
  });

  // Also build a global Players lookup (all players, not just roster) so we can
  // match external subs who appear in CR_Attendance but aren't on this league's roster.
  const allMemberToPlayer = {};   // club_member_id → {player_id, full_name, level}
  const allNameToPlayer   = {};   // 'first|last'   → {player_id, full_name, level}
  getObjects_('Players').forEach(p => {
    if (p.club_member_id) {
      allMemberToPlayer[String(p.club_member_id).trim()] = p;
    }
    const nk = (String(p.first_name || '').trim().toLowerCase() + '|' +
                String(p.last_name  || '').trim().toLowerCase());
    if (nk !== '|') allNameToPlayer[nk] = p;
  });

  // Scan CR_Attendance — track no-shows and subs separately.
  const noShowSet    = {};
  const subSet       = {};
  const presentSet   = {};   // rostered players whose CR row indicates they checked in (not no-show / not sub)
  const externalSubs = {};   // player_id or temp-key → {player_id, full_name, member_number, is_temp}
  let rowsChecked = 0, byId = 0, byName = 0;
  let latestMatchDate = '';

  getObjects_('CR_Attendance').forEach(a => {
    // reservation_start may be a JS Date (Sheets auto-parses datetime strings).
    const rsv = a.reservation_start;
    const rowDate = rsv instanceof Date
      ? Utilities.formatDate(rsv, CONFIG.TIMEZONE, 'yyyy-MM-dd')
      : String(rsv || '').replace('T', ' ').slice(0, 10);
    if (hasDate) {
      if (rowDate !== dateStr) return;
    } else {
      if (!rowDate) return;
      const rowMs = new Date(rowDate).getTime();
      if (isNaN(rowMs) || rowMs < windowStart || rowMs > windowEnd) return;
    }
    // Skip if this attendance record belongs to a different league's event.
    if (hasEventFilter) {
      const rowEvent = a.event_name || '';
      const rowEventNorm = rowEvent.trim().toLowerCase();
      if (!matchesLeagueEvent(rowEvent) && !assignedEventNames[rowEventNorm]) return;
    }
    rowsChecked++;

    // Classify the record. Anything that isn't no-show / sub-for-league is
    // treated as "present" (checked in, attended, etc.).
    const statusNorm = (a.check_in_status || '').toLowerCase().replace(/\s+/g, '');
    const isSub     = statusNorm.indexOf('subforleague') !== -1;
    const isNoShow  = !isSub && statusNorm.indexOf('noshow') !== -1;
    const isPresent = !isSub && !isNoShow;

    // Try matching against the roster first.
    const memNum = String(a.member_number || '').trim();
    let pid = memNum ? memberToPlayerId[memNum] : undefined;
    if (!pid) {
      const aNameKey = (String(a.first_name || '').trim().toLowerCase() + '|' +
                        String(a.last_name  || '').trim().toLowerCase());
      pid = aNameKey !== '|' ? nameToPlayerId[aNameKey] : undefined;
      if (pid) byName++;
    } else {
      byId++;
    }

    if (pid) {
      // Player is on the roster — tag them normally.
      if (isSub)     subSet[pid]     = true;
      if (isNoShow)  noShowSet[pid]  = true;
      if (isPresent) presentSet[pid] = true;
      if (rowDate > latestMatchDate) latestMatchDate = rowDate;
      return;
    }
    if (isPresent) return;  // non-rostered + present = irrelevant (someone else's league)

    // Player is NOT on the roster but appears as a sub — surface as external sub.
    // When hasEventFilter is true, event name already confirms the right league.
    // When the operator provides a specific date (hasDate=true), show external
    // subs regardless — they know which league they're operating.
    // The ambiguous case is no event filter AND no specific date (window mode).
    if (isSub && (hasEventFilter || hasDate)) {
      if (rowDate > latestMatchDate) latestMatchDate = rowDate;
      // Try to resolve them via the global Players table.
      let extPlayer = (memNum ? allMemberToPlayer[memNum] : null);
      if (!extPlayer) {
        const nk = (String(a.first_name || '').trim().toLowerCase() + '|' +
                    String(a.last_name  || '').trim().toLowerCase());
        extPlayer = nk !== '|' ? allNameToPlayer[nk] : null;
      }
      const key   = extPlayer ? extPlayer.player_id : ('ext|' + memNum + '|' +
                    String(a.first_name || '').trim() + ' ' + String(a.last_name || '').trim());
      const fname = extPlayer
        ? extPlayer.full_name
        : ((String(a.first_name || '').trim() + ' ' + String(a.last_name || '').trim()).trim());
      externalSubs[key] = {
        player_id:     extPlayer ? extPlayer.player_id : null,
        full_name:     fname,
        level:         extPlayer ? (extPlayer.level || '') : '',
        member_number: memNum,
        is_temp:       !extPlayer,  // true when not found in Players table
      };
    }
  });

  // If no specific date given, report the most recent date that had hits
  const reportedDate = hasDate ? dateStr : (latestMatchDate || '');

  return {
    no_show_player_ids:     Object.keys(noShowSet),
    sub_player_ids:         Object.keys(subSet),
    present_player_ids:     Object.keys(presentSet),
    external_subs:          Object.values(externalSubs),  // players subbing in who aren't on the roster
    // legacy field — union of no-shows + subs so callers that only check player_ids still work
    player_ids:             Object.keys(Object.assign({}, noShowSet, subSet)),
    date:                   reportedDate,
    roster_checked:         rosterPlayerIds.length,
    members_with_id:        membersWithId,
    matched_by_id:          byId,
    matched_by_name:        byName,
    attendance_rows_checked: rowsChecked,
  };
}

/* =========================================================================
 * CR Members
 *
 * Endpoint: GET /api/v1/members  (paginated)
 * Response: { Data: { Members: [...], TotalPages, PageNumber, PageSize }, IsSuccessStatusCode }
 *
 * Dedup key: OrganizationMemberId (cr_member_id).
 * MembershipNumber bridges to CR_Attendance.member_number — the main reason
 * to pull this list.
 * ========================================================================= */

const CR_MEMBERS_PATH_DEFAULT = CR_API_PREFIX + '/memberreport/list';

/**
 * Fetch one page of members from CR.
 * @param {number} pageNumber  1-based
 * @param {number} pageSize    records per page (default 200)
 * @param {Object} extra       additional query params (e.g. membershipStatus)
 */
function crFetchMembersPage_(pageNumber, pageSize, extra) {
  const path = (extra && extra._path) || CR_MEMBERS_PATH_DEFAULT;
  const q = Object.assign({
    pageNumber: pageNumber,
    pageSize:   pageSize || 200,
  }, extra || {});
  delete q._path;
  const r = crFetch_('GET', path, { query: q });
  if (r.status < 200 || r.status >= 300) {
    throw new Error('CR members HTTP ' + r.status + ': ' + crSample_(r.body));
  }
  const body = r.body || {};
  const data = body.Data || {};
  return {
    members:    Array.isArray(data.Members) ? data.Members : [],
    totalPages: data.TotalPages || 1,
    pageNumber: data.PageNumber || pageNumber,
  };
}

/**
 * Pull all members from CR (auto-paginates) and upsert into CR_Members.
 * Dedup key: cr_member_id (OrganizationMemberId).
 * @param {Object} filters  optional extra query params (e.g. { membershipStatus: 'Active' })
 * @returns {{ added, updated, total }}
 */
function pullMembersFromCR_(filters) {
  filters = filters || {};
  const pageSize = 200;
  let page = 1, allMembers = [];

  // Fetch first page to get total
  const first = crFetchMembersPage_(page, pageSize, filters);
  allMembers = allMembers.concat(first.members);
  const totalPages = first.totalPages || 1;

  for (page = 2; page <= totalPages; page++) {
    const r = crFetchMembersPage_(page, pageSize, filters);
    allMembers = allMembers.concat(r.members);
    // Throttle slightly to stay under 60 req/min
    if (page % 10 === 0) Utilities.sleep(500);
  }

  // Build index of existing rows
  const existing = getObjects_('CR_Members');
  const byId = {};
  existing.forEach(r => { byId[String(r.cr_member_id || '')] = r; });

  const toAppend = [];
  const updates  = [];

  allMembers.forEach(m => {
    const id  = String(m.OrganizationMemberId || '');
    if (!id) return;
    const row = {
      cr_member_id:              id,
      membership_number:         String(m.MembershipNumber || '').trim(),
      imported_at:               nowStamp_(),
      first_name:                m.FirstName  || '',
      last_name:                 m.LastName   || '',
      email:                     (m.Email     || '').toLowerCase().trim(),
      phone:                     m.PhoneNumber || '',
      gender:                    m.Gender     || '',
      date_of_birth:             m.DateOfBirth ? String(m.DateOfBirth).slice(0, 10) : '',
      membership_type:           m.MembershipTypeName || '',
      membership_type_id:        m.MembershipTypeId   != null ? String(m.MembershipTypeId) : '',
      membership_status:         m.MembershipStatus   || '',
      membership_assignment_type: m.MembershipAssignmentType || '',
      membership_start:          m.MembershipStartDate ? String(m.MembershipStartDate).slice(0, 10) : '',
      membership_end:            m.MembershipEndDate   ? String(m.MembershipEndDate).slice(0, 10)   : '',
      family_id:                 m.OrganizationMemberFamilyId != null ? String(m.OrganizationMemberFamilyId) : '',
      family_role:               m.FamilyRole || '',
      allow_child_login:         m.AllowChildToLoginAndUseBookingPrivileges ? 'TRUE' : 'FALSE',
      address:                   m.Address || '',
      city:                      m.City    || '',
      state:                     m.State   || '',
      zip:                       m.ZipCode || '',
      unsub_marketing_email:     m.UnsubscribeFromMarketingEmails                  ? 'TRUE' : 'FALSE',
      unsub_marketing_push:      m.UnsubscribeFromMarketingPushNotifications       ? 'TRUE' : 'FALSE',
      unsub_marketing_text:      m.UnsubscribeFromMarketingTextAlerts              ? 'TRUE' : 'FALSE',
      unsub_org_text:            m.UnsubscribeFromOrganizationTextAlerts           ? 'TRUE' : 'FALSE',
      external_id:               m.ExternalId || '',
      udf_json:                  JSON.stringify(m.UserDefinedFields || []),
      raw_json:                  JSON.stringify(m),
    };
    if (byId[id]) {
      updates.push({ cr_member_id: id, patch: row });
    } else {
      toAppend.push(row);
      byId[id] = row;
    }
  });

  if (toAppend.length) appendObjects_('CR_Members', toAppend);
  if (updates.length) {
    const patchById = {};
    updates.forEach(u => { patchById[u.cr_member_id] = u.patch; });
    updateWhere_('CR_Members',
      r => !!patchById[String(r.cr_member_id)],
      r => Object.assign(r, patchById[String(r.cr_member_id)]));
  }

  crLogSync_({
    kind:    'pull_members',
    method:  'GET',
    path:    (filters && filters._path) || CR_MEMBERS_PATH_DEFAULT,
    http_status: 200,
    count:   allMembers.length,
    status:  'ok',
    message: 'total=' + allMembers.length + ' added=' + toAppend.length + ' updated=' + updates.length,
  });

  return { added: toAppend.length, updated: updates.length, total: allMembers.length };
}

/** Return all CR_Members rows, sorted by last_name. */
function listCRMembers_(opts) {
  opts = opts || {};
  let rows = getObjects_('CR_Members');
  if (opts.search) {
    const q = opts.search.toLowerCase();
    rows = rows.filter(r =>
      (r.first_name + ' ' + r.last_name + ' ' + r.email + ' ' + (r.membership_number || '')).toLowerCase().indexOf(q) !== -1
    );
  }
  rows.sort((a, b) => String(a.last_name).localeCompare(String(b.last_name)));
  const limit = opts.limit || 500;
  return rows.slice(0, limit);
}

/** Clear all rows from CR_Members. */
function clearCRMembers_() {
  overwriteObjects_('CR_Members', []);
  return { cleared: true };
}

/**
 * Return distinct event dates (yyyy-MM-dd) found in CR_Attendance whose
 * event_name matches this league. Useful when the league has no
 * League_Schedule rows but attendance data has been pulled. No assignment
 * step required.
 *
 * @param {string} league_id
 * @returns {Array<{date: string, event_name: string, count: number}>}
 */
function getLadderSessionDatesFromAttendance_(league_id) {
  const league = getLeagueById_(league_id);
  if (!league) throw new Error('League not found: ' + league_id);
  const targetName = (league.name || '').trim();

  const map = {};
  getObjects_('CR_Attendance').forEach(a => {
    if (!_crEventNameMatches_(a.event_name, targetName)) return;
    const rs = a.reservation_start;
    const raw = rs instanceof Date
      ? Utilities.formatDate(rs, CONFIG.TIMEZONE, 'yyyy-MM-dd')
      : String(rs || '').replace('T', ' ').slice(0, 10);
    const date = raw.slice(0, 10);
    if (!date) return;
    if (!map[date]) map[date] = { event_name: a.event_name || '', count: 0 };
    map[date].count++;
  });
  return Object.keys(map)
    .sort()
    .map(d => ({ date: d, event_name: map[d].event_name, count: map[d].count }));
}

/**
 * Return the distinct event dates (yyyy-MM-dd) that have CR_Registrations rows
 * assigned to this league, sorted chronologically.  Used by the Operator to
 * populate the session-date picker when the league has no League_Schedule entries.
 *
 * @param {string} league_id
 * @returns {Array<{date: string, event_name: string, count: number}>}
 */
function getCREventDatesForLeague_(league_id) {
  const map = {};  // date → {event_name, count}
  getObjects_('CR_Registrations').forEach(r => {
    if (r.assigned_league_id !== league_id) return;
    const es = r.event_start;
    const raw = es instanceof Date
      ? Utilities.formatDate(es, CONFIG.TIMEZONE, 'yyyy-MM-dd')
      : String(es || '').replace('T', ' ').slice(0, 10);
    if (!raw) return;
    const date = raw.slice(0, 10);  // yyyy-MM-dd (ISO prefix)
    if (!map[date]) map[date] = { event_name: r.event_name || '', count: 0 };
    map[date].count++;
  });
  return Object.keys(map)
    .sort()
    .map(d => ({ date: d, event_name: map[d].event_name, count: map[d].count }));
}
