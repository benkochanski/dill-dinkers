/**
 * DUPR RaaS integration.
 *
 * Two responsibilities:
 *   1. SSO linking — partner-iframe flow per
 *      https://dupr.gitbook.io/dupr-raas/integration-checklist/sso-login
 *      The Link.html page embeds an iframe pointed at DUPR's SSO surface
 *      and listens for a postMessage with the player's verified duprId.
 *   2. Match push — POSTs completed games to DUPR's match-create endpoint
 *      using a minted partner bearer token.
 *
 * Credentials in Script Properties:
 *   DUPR_BASE_URL        e.g. 'https://uat.mydupr.com/api' or
 *                            'https://prod.mydupr.com/api'
 *   DUPR_CLIENT_ID       The partner clientKey from DUPR onboarding
 *   DUPR_CLIENT_SECRET   The partner clientSecret from DUPR onboarding
 *   DUPR_SSO_BASE_URL    (optional) Override SSO host. If unset, derived
 *                        from DUPR_BASE_URL (uat.dupr.gg or dashboard.dupr.com).
 *   DUPR_PARTNER_TOKEN   (optional) Long-lived bearer token. If set, used
 *                        instead of minting via /auth/login.
 *
 * Per the docs, access tokens last 1 hour. We cache for 50 min and re-mint.
 */

/* ============================================================
 * Configuration helpers
 * ============================================================ */

function duprConfig_() {
  const p = PropertiesService.getScriptProperties();
  const base = (p.getProperty('DUPR_BASE_URL') || '').replace(/\/+$/, '');
  const ssoOverride = (p.getProperty('DUPR_SSO_BASE_URL') || '').replace(/\/+$/, '');
  return {
    base_url:         base,
    sso_base_url:     ssoOverride || _deriveDuprSsoBase_(base),
    // SSO iframe uses clientKey from onboarding. API auth uses
    // client_id + client_secret. They MAY be the same value but
    // are conceptually different. Set DUPR_CLIENT_KEY explicitly
    // if you have a separate SSO value; otherwise we fall back to
    // DUPR_CLIENT_ID.
    client_key:       p.getProperty('DUPR_CLIENT_KEY') || p.getProperty('DUPR_CLIENT_ID') || '',
    client_id:        p.getProperty('DUPR_CLIENT_ID') || '',
    client_secret:    p.getProperty('DUPR_CLIENT_SECRET') || '',
  };
}

function _deriveDuprSsoBase_(apiBase) {
  if (!apiBase) return '';
  if (/uat/i.test(apiBase)) return 'https://uat.dupr.gg';
  return 'https://dashboard.dupr.com';
}

function duprConfigured_() {
  const c = duprConfig_();
  return !!c.base_url && !!c.client_key && !!c.client_secret;
}

/* ============================================================
 * Bearer token mint + cache.
 *
 * Per docs:
 *   POST {base_url}/auth/login
 *   Header: x-authorization: base64(clientKey:clientSecret)
 *   → response contains a bearer token (1-hour TTL)
 *
 * Field name varies — we try common candidates and surface whatever
 * works.
 * ============================================================ */

function duprBearerToken_(forceRefresh) {
  const c = duprConfig_();
  const cache = CacheService.getScriptCache();
  if (forceRefresh) cache.remove('dupr_bearer_token');
  else {
    const cached = cache.get('dupr_bearer_token');
    if (cached) return cached;
  }
  if (!c.client_key || !c.client_secret) {
    throw new Error('DUPR_CLIENT_KEY + DUPR_CLIENT_SECRET required to mint bearer token');
  }
  // Per Swagger: POST {base}/auth/v1.0/token
  // Header: x-authorization: base64(ClientKey:ClientSecret)
  // No body required.
  const url = c.base_url + '/auth/v1.0/token';
  const resp = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: {
      'x-authorization': Utilities.base64Encode(c.client_key + ':' + c.client_secret),
      'Accept':          'application/json',
    },
    muteHttpExceptions: true,
  });
  const status = resp.getResponseCode();
  const text = resp.getContentText();
  if (status >= 400) throw new Error('Bearer mint failed (' + status + '): ' + text);
  let body;
  try { body = JSON.parse(text); } catch (e) { throw new Error('Bearer mint response not JSON: ' + text); }
  const result = body.result || body;
  const token = result.token || result.accessToken || body.token || body.access_token || '';
  if (!token) throw new Error('No token field in bearer mint response: ' + text);
  // Derive cache TTL from the expiry timestamp if present; otherwise default
  // to 50 min (DUPR docs say 1-hour tokens).
  let ttl = 50 * 60;
  if (result.expiry) {
    const exp = new Date(result.expiry).getTime();
    if (!isNaN(exp)) {
      const remaining = Math.floor((exp - Date.now()) / 1000) - 60;  // 60s safety
      if (remaining > 60) ttl = Math.min(remaining, 6 * 3600);
    }
  }
  try { cache.put('dupr_bearer_token', token, ttl); } catch (e) { /* swallow */ }
  return token;
}

/** Force-refresh the cached bearer token. Useful from the editor for debugging. */
function duprRefreshBearer() {
  CacheService.getScriptCache().remove('dupr_bearer_token');
  const t = duprBearerToken_();
  Logger.log('Got bearer token (len %s): %s…', t.length, t.slice(0, 24));
  return { ok: true, token_prefix: t.slice(0, 24) + '…' };
}

/* ============================================================
 * Generic API fetch
 * ============================================================ */

function duprFetch_(method, path, opts) {
  const c = duprConfig_();
  if (!c.base_url) throw new Error('DUPR_BASE_URL not configured');
  opts = opts || {};
  const url = c.base_url + (path.charAt(0) === '/' ? path : '/' + path) +
              (opts.query ? '?' + _encodeQuery_(opts.query) : '');
  function buildParams(token) {
    const headers = Object.assign({
      'Accept':       'application/json',
      'Content-Type': 'application/json',
    }, opts.headers || {});
    if (!headers.Authorization && !opts.no_auth) headers.Authorization = 'Bearer ' + token;
    const p = {
      method:             method.toLowerCase(),
      headers:            headers,
      muteHttpExceptions: true,
      followRedirects:    opts.follow_redirects !== false,
    };
    if (opts.body !== undefined) {
      p.payload = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    }
    return p;
  }
  let token = opts.no_auth ? '' : duprBearerToken_();
  let resp = UrlFetchApp.fetch(url, buildParams(token));
  let status = resp.getResponseCode();
  // 401 → token expired (despite cache TTL); force-refresh once and retry.
  if (status === 401 && !opts.no_auth && !opts.no_retry) {
    token = duprBearerToken_(true);
    resp = UrlFetchApp.fetch(url, buildParams(token));
    status = resp.getResponseCode();
  }
  const text = resp.getContentText();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
  return { status: status, body_text: text, body_json: json };
}

function _encodeQuery_(obj) {
  return Object.keys(obj)
    .filter(k => obj[k] !== undefined && obj[k] !== null && obj[k] !== '')
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]))
    .join('&');
}

/* ============================================================
 * SSO — iframe partner flow
 *
 * 1. renderLink_ in Web.js calls duprStartSsoForPlayer_(pid) to get
 *    { iframe_url, state }. State is a one-time nonce stored in cache
 *    that maps back to player_id.
 * 2. Link.html embeds <iframe src="<iframe_url>"> and listens for
 *    postMessage from DUPR.
 * 3. On message, Link.html calls api_finalizeDuprLink(state, payload).
 * 4. duprFinalizeSso_ validates state → writes Players.dupr_id.
 * ============================================================ */

function duprBuildSsoIframeUrl_() {
  const c = duprConfig_();
  if (!c.sso_base_url) throw new Error('Cannot derive DUPR SSO base URL — set DUPR_SSO_BASE_URL');
  if (!c.client_key)   throw new Error('DUPR_CLIENT_KEY (or DUPR_CLIENT_ID fallback) not configured');
  // Docs: `:clientKey` is the Base64-encoded clientKey from onboarding
  // (NOT clientKey:secret). URL-safe + unpadded — standard base64 puts `=`
  // padding in the URL path, which some endpoints reject.
  const encoded = Utilities.base64EncodeWebSafe(c.client_key).replace(/=+$/, '');
  return c.sso_base_url + '/login-external-app/' + encoded;
}

function duprStartSsoForPlayer_(player_id) {
  if (!player_id) throw new Error('player_id required');
  const player = getObjects_('Players').find(p => p.player_id === player_id);
  if (!player) throw new Error('Player not found: ' + player_id);
  const state = Utilities.getUuid();
  CacheService.getScriptCache().put('dupr_sso_state:' + state, player_id, 1800);  // 30 min
  audit_('dupr_sso_start', 'player', player_id, null, { state: state });
  return {
    iframe_url: duprBuildSsoIframeUrl_(),
    state:      state,
  };
}

function duprFinalizeSso_(state, payload) {
  if (!state)               throw new Error('state required');
  if (!payload)             throw new Error('payload required');
  const duprId = String(payload.duprId || payload.dupr_id || '').trim();
  if (!duprId)              throw new Error('duprId missing from postMessage payload');
  const cache = CacheService.getScriptCache();
  const player_id = cache.get('dupr_sso_state:' + state);
  if (!player_id)           throw new Error('state expired or unknown — restart the link flow');
  cache.remove('dupr_sso_state:' + state);

  const player = getObjects_('Players').find(p => p.player_id === player_id);
  if (!player) throw new Error('Player not found: ' + player_id);

  const userId = String(payload.id || payload.userId || payload.userid || '').trim();

  // OPTIONAL HARDENING (TODO): verify duprId server-side using the userToken
  // from the postMessage. Hit GET /user/v1.0/me with Authorization:Bearer
  // <userToken> and confirm the duprId matches. For sandbox we trust the
  // origin-checked postMessage.

  const before = Object.assign({}, player);
  updateWhere_('Players',
    p => p.player_id === player_id,
    p => {
      p.dupr_id          = duprId;
      p.dupr_player_uuid = userId;
      p.link_source      = 'sso';
      p.linked_at        = nowStamp_();
    });
  audit_('dupr_link_sso', 'player', player_id, before, { dupr_id: duprId, user_id: userId });
  return { player_id: player_id, dupr_id: duprId };
}

/* ============================================================
 * User profile lookup
 *
 *   GET {base}/user/v1.0/{duprId}
 *   Authorization: Bearer <partner-token>
 *
 * Returns normalized profile data (name, doubles rating, W/L).
 * ============================================================ */

/**
 * Extended/consented user info from /user/v1.0/{duprId}/details (partner host,
 * partner bearer). Returns Full Name, Birth Year, Gender, Email — the fields
 * a player consents to share on the DUPR authorization screen.
 *
 * Requires DUPR to grant our production API key the authority for this
 * endpoint. Until granted it 403s; we swallow that and return {} so the rest
 * of the profile still works. Once granted, the consented fields flow through
 * automatically — no further code change.
 */
function duprFetchUserDetailsSafe_(duprId) {
  if (!duprId) return {};
  try {
    const resp = duprFetch_('GET', '/user/v1.0/' + encodeURIComponent(duprId) + '/details');
    if (resp.status >= 200 && resp.status < 300 && resp.body_json) {
      return resp.body_json.result || resp.body_json || {};
    }
    // 403 = authority not yet granted; anything else = transient. Log once.
    if (resp.status === 403) {
      Logger.log('duprFetchUserDetailsSafe_: /details 403 (authority grant pending) for %s', duprId);
    } else {
      Logger.log('duprFetchUserDetailsSafe_: /details %s for %s: %s', resp.status, duprId, (resp.body_text || '').slice(0, 200));
    }
  } catch (e) {
    Logger.log('duprFetchUserDetailsSafe_ error: %s', e && e.message);
  }
  return {};
}

function duprFetchUserProfile_(duprId, userToken) {
  let result = null;
  let source = '';

  // Preferred: /me with the user's own SSO token. This is a USER-SCOPED
  // endpoint → lives on the user API host (api.dupr.gg / api.uat.dupr.gg),
  // NOT the partner host. It returns full PII (email, phone, gender, etc.).
  if (userToken) {
    const url = _duprUserApiBase_() + '/user/v1.0/me';
    const r = UrlFetchApp.fetch(url, {
      method:  'get',
      headers: { 'Authorization': 'Bearer ' + userToken, 'Accept': 'application/json' },
      muteHttpExceptions: true,
    });
    const status = r.getResponseCode();
    const text = r.getContentText();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
    if (status < 400 && json) {
      result = json.result || json;
      source = 'me';
      Logger.log('duprFetchUserProfile_ /me OK; keys: %s', Object.keys(result).join(', '));
    } else {
      Logger.log('duprFetchUserProfile_ /me failed (%s) at %s; falling back. Body: %s',
        status, url, (text || '').slice(0, 400));
    }
  }

  // Fallback: public /user/v1.0/{duprId} (no PII, only ratings + name).
  if (!result) {
    if (!duprId) throw new Error('duprId required (userToken fetch failed)');
    const resp = duprFetch_('GET', '/user/v1.0/' + encodeURIComponent(duprId));
    if (resp.status >= 400) {
      throw new Error('DUPR profile fetch failed (' + resp.status + '): ' + resp.body_text);
    }
    result = (resp.body_json && resp.body_json.result) || resp.body_json || {};
    source = 'byid';
  }

  const ratings    = result.ratings || {};
  const perfDbl    = ((result.performance || {}).doubles) || {};
  const perfSgl    = ((result.performance || {}).singles) || {};
  const first      = result.firstName || result.first_name || '';
  const last       = result.lastName  || result.last_name  || '';
  // by-id returns the MASKED "partial name" (e.g. "Ahmad E.").
  const partialName = (result.fullName || (first + ' ' + last)).trim();
  // DUPR's W/L counts are sometimes returned as huge sentinel values
  // (~ -2.2e12, i.e. a 1900-epoch millisecond default) for formats a player
  // has never played. Clamp anything out of [0, 1e6] to 0.
  const sanePerf = v => {
    const n = Number(v);
    if (!isFinite(n) || n < 0 || n > 1e6) return 0;
    return n;
  };

  // Extended/consented info (Full Name, Birth Year, Gender, Email) lives on
  // the /details endpoint, which requires a DUPR-granted authority on our
  // partner key. Returns {} (no error) until that grant is in place.
  const details = duprFetchUserDetailsSafe_(duprId);

  return {
    dupr_id:                       result.id || duprId,
    // Names: partial (masked, always) + full (consented, via /details).
    dupr_partial_name:             partialName,
    dupr_full_name:                String(details.fullName || details.full_name || '').trim(),
    full_name:                     String(details.fullName || details.full_name || partialName).trim(),
    first_name:                    String(details.firstName || first).trim(),
    last_name:                     String(details.lastName || last).trim(),
    // Consented PII (only present once /details is authorized + user shared).
    email:                         String(details.email || details.emailAddress || '').trim(),
    phone:                         String(details.phone || details.phoneNumber || details.mobile || '').trim(),
    gender:                        String(details.gender || details.sex || '').trim(),
    birth_year:                    details.birthYear == null ? (details.birthyear == null ? null : Number(details.birthyear)) : Number(details.birthYear),
    age:                           details.age == null ? null : Number(details.age),
    location:                      String(details.location || details.shortAddress || details.address || '').trim(),
    // Doubles
    doubles_rating:                String(ratings.doubles == null ? '' : ratings.doubles),
    doubles_reliable:              !!ratings.isDoublesReliable,
    doubles_reliability_score:     ratings.doublesReliabilityScore == null ? null : Number(ratings.doublesReliabilityScore),
    doubles_wins:                  sanePerf(perfDbl.win),
    doubles_losses:                sanePerf(perfDbl.loss),
    doubles_total:                 sanePerf(perfDbl.total),
    // Singles
    singles_rating:                String(ratings.singles == null ? '' : ratings.singles),
    singles_reliable:              !!ratings.isSinglesReliable,
    singles_reliability_score:     ratings.singlesReliabilityScore == null ? null : Number(ratings.singlesReliabilityScore),
    singles_wins:                  sanePerf(perfSgl.win),
    singles_losses:                sanePerf(perfSgl.loss),
    singles_total:                 sanePerf(perfSgl.total),
    _source:                       source,  // diagnostic — strip if needed
  };
}

/* ============================================================
 * Match push
 *
 * POST {base_url}/match/v1.0/create  (verify path against your docs)
 * Authorization: Bearer <minted partner token>
 *
 * Body shape mirrors what worked in the CPBL dupr-platform; adjust
 * field names if DUPR's match-create contract differs.
 * ============================================================ */

function duprPushMatch_(game_id) {
  const game = getObjects_('Games').find(g => g.game_id === game_id);
  if (!game) throw new Error('Game not found: ' + game_id);
  if (game.status === 'voided') throw new Error('Cannot push voided game');
  if (String(game.t1_score) === '' || String(game.t2_score) === '') {
    throw new Error('Game has no final score');
  }

  const players = getObjects_('Players');
  const byId = {};
  players.forEach(p => { byId[p.player_id] = p; });
  const pids = [game.t1_player_1_id, game.t1_player_2_id, game.t2_player_1_id, game.t2_player_2_id];
  const missing = [];
  const duprs = pids.map(pid => {
    const p = byId[pid];
    if (!p) { missing.push(pid + ' (no Players row)'); return ''; }
    const d = String(p.dupr_id || '').trim();
    if (!d) missing.push((p.full_name || pid) + ' (not linked)');
    return d;
  });
  if (missing.length) throw new Error('Cannot push — players missing DUPR link: ' + missing.join(', '));

  // DUPR gating per RaaS spec: all four players must have BASIC_L1 entitlement.
  ensurePlayersBasicL1_(pids);

  // Club gating per RaaS spec: if a club is configured, verify the admin
  // user has DIRECTOR/ORGANIZER role on that club. Returns the source
  // ('CLUB' if configured, 'PARTNER' otherwise) and clubId.
  const clubRole = ensureAdminClubRole_();

  // Payload per ExternalMatchRequest schema (Swagger /v3/api-docs):
  //   identifier (unique), matchDate (yyyy-MM-dd), matchType (SIDEOUT|RALLY),
  //   scoreType (REGULAR — verify), format (SINGLES|DOUBLES), teams[],
  //   source (PARTNER or CLUB), clubId (required if source=CLUB).
  const payload = {
    identifier: game_id,
    event:      String(game.event_label || 'Dill Dinkers Sandbox'),
    matchDate:  _formatDuprDate_(game.play_date) || _formatDuprDate_(new Date()),
    matchType:  'SIDEOUT',
    scoreType:  'REGULAR',
    format:     'DOUBLES',
    source:     clubRole.source,
    teamA: { player1: duprs[0], player2: duprs[1], game1: Number(game.t1_score) },
    teamB: { player1: duprs[2], player2: duprs[3], game1: Number(game.t2_score) },
  };
  if (clubRole.source === 'CLUB' && clubRole.club_id) {
    payload.clubId = clubRole.club_id;
  }

  const resp = duprFetch_('POST', '/match/v1.0/create', { body: payload });
  const ok = resp.status >= 200 && resp.status < 300;
  const respJson = resp.body_json || {};
  const result = respJson.result || {};
  // matchCode is the upsert-friendly id per the docs.
  const duprMatchId = result.matchCode || result.identifier || result.hashedMatchCode ||
                      respJson.matchCode || respJson.id || '';

  const truncate = s => (s || '').toString().slice(0, 4000);
  appendObjects_('DUPR_Push_Log', [{
    push_id:         makeId_('push'),
    game_id:         game_id,
    attempted_at:    nowStamp_(),
    status:          ok ? 'success' : 'error',
    http_status:     resp.status,
    request_payload: truncate(JSON.stringify(payload)),
    response_body:   truncate(resp.body_text),
    dupr_match_id:   duprMatchId,
    error_message:   ok ? '' : truncate(respJson.message || respJson.error || resp.body_text),
    attempted_by:    activeUserEmail_(),
  }]);

  if (ok) {
    updateWhere_('Games',
      g => g.game_id === game_id,
      g => {
        g.dupr_match_id    = duprMatchId;
        g.dupr_push_status = 'success';
        g.dupr_push_error  = '';
        g.status           = 'pushed';
        g.updated_at       = nowStamp_();
      });
    audit_('dupr_push_success', 'game', game_id, null, { dupr_match_id: duprMatchId });
    return { ok: true, dupr_match_id: duprMatchId, http_status: resp.status };
  }
  const errMsg = (respJson.message || respJson.error || resp.body_text || '').toString().slice(0, 500);
  updateWhere_('Games',
    g => g.game_id === game_id,
    g => {
      g.dupr_push_status = 'error';
      g.dupr_push_error  = errMsg;
      g.updated_at       = nowStamp_();
    });
  audit_('dupr_push_error', 'game', game_id, null, { http_status: resp.status, error: errMsg });
  throw new Error('DUPR push failed (' + resp.status + '): ' + errMsg);
}

/* ============================================================
 * Entitlements — DUPR user gating per the RaaS spec.
 *
 *   Endpoint: GET /<some-version>/subscriptions  (Subscriptions Controller)
 *   Authorization: Bearer <user-access-token>   (user-context, NOT partner)
 *
 * Response shape (per docs):
 *   {
 *     status: "",
 *     displayName: "...",
 *     entitlements: { tournaments: ["BASIC_L1", "PREMIUM_L1", ...] }
 *   }
 *
 * DUPR docs say the entitlements may be cached up to 24 hours. Callers
 * (registration, push-gate, daily cron) should respect that.
 *
 * The DUPR docs don't show the explicit URL path — they direct to the
 * API explorer. We try a few likely paths and use whichever responds 2xx.
 * ============================================================ */

// Per DUPR docs, the subscriptions endpoint lives on a DIFFERENT host than
// the partner API: api.uat.dupr.gg (UAT) / api.dupr.gg (prod). Derived from
// DUPR_BASE_URL or overridden by DUPR_USER_API_BASE_URL Script Property.
function _duprUserApiBase_() {
  const override = (PropertiesService.getScriptProperties()
    .getProperty('DUPR_USER_API_BASE_URL') || '').replace(/\/+$/, '');
  if (override) return override;
  const base = duprConfig_().base_url;
  if (/uat/i.test(base)) return 'https://api.uat.dupr.gg';
  return 'https://api.dupr.gg';
}

// Canonical endpoint per DUPR support (confirmed for UAT):
//   POST https://api.uat.dupr.gg/subscription/active
//   Authorization: Bearer <user SSO access token>
function duprFetchUserEntitlements_(userToken) {
  if (!userToken) throw new Error('userToken required to fetch entitlements');
  const host = _duprUserApiBase_();
  const url = host + '/subscription/active';
  const resp = UrlFetchApp.fetch(url, {
    method:  'post',
    headers: {
      'Authorization': 'Bearer ' + userToken,
      'Accept':        'application/json',
      'Content-Type':  'application/json',
    },
    payload: '{}',
    muteHttpExceptions: true,
    followRedirects:    true,
  });
  const status = resp.getResponseCode();
  const text = resp.getContentText();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
  if (status === 401) {
    throw new Error('User token rejected (401) — re-link DUPR required: ' + (text || '').slice(0, 200));
  }
  if (status >= 400 || !json) {
    throw new Error('DUPR /subscription/active failed (' + status + '): ' + (text || '').slice(0, 400));
  }
  // Actual response shape (UAT-confirmed):
  //   { subscriptions: [{ status: "active", displayName, entitlements: { tournaments: [...] } }] }
  // Docs example showed flat shape — handle both, prefer the array.
  const result = json.result || json;
  let tournaments = [];
  if (Array.isArray(result.subscriptions)) {
    result.subscriptions.forEach(sub => {
      // Only count active subscriptions
      if (sub.status && String(sub.status).toLowerCase() !== 'active') return;
      const t = (sub.entitlements || {}).tournaments || [];
      tournaments = tournaments.concat(t);
    });
  } else if (result.entitlements && Array.isArray(result.entitlements.tournaments)) {
    tournaments = result.entitlements.tournaments;
  }
  // Dedupe
  tournaments = Array.from(new Set(tournaments));
  return {
    tournaments:     tournaments,
    has_basic_l1:    tournaments.indexOf('BASIC_L1')    !== -1,
    has_premium_l1:  tournaments.indexOf('PREMIUM_L1')  !== -1,
    has_verified_l1: tournaments.indexOf('VERIFIED_L1') !== -1,
    _path:           '/subscription/active',
    _host:           host,
  };
}

/**
 * Gate: ensure every player has BASIC_L1. Refreshes per-player if stale
 * (>24h) AND a user token is on file. Throws with a list of who's missing
 * the entitlement; otherwise no-op.
 */
function ensurePlayersBasicL1_(player_ids) {
  const players = getObjects_('Players');
  const byId = {};
  players.forEach(p => { byId[p.player_id] = p; });

  const refreshIfStale = pid => {
    const p = byId[pid];
    if (!p) return null;
    const fetchedAt = p.entitlements_fetched_at;
    let needsRefresh = !fetchedAt;
    if (fetchedAt) {
      const ageMs = Date.now() - new Date(fetchedAt).getTime();
      if (isNaN(ageMs) || ageMs > 24 * 3600 * 1000) needsRefresh = true;
    }
    if (needsRefresh && (p.dupr_user_token || p.dupr_refresh_token)) {
      try {
        // Uses the wrapper — if access token is expired, it'll silently
        // exchange the refresh token for a new one and retry.
        const ent = fetchPlayerEntitlementsWithRefresh_(p);
        const stamp = nowStamp_();
        updateWhere_('Players', x => x.player_id === p.player_id, x => {
          x.entitlements_tournaments = (ent.tournaments || []).join(',');
          x.has_basic_l1             = ent.has_basic_l1    ? 'TRUE' : 'FALSE';
          x.has_premium_l1           = ent.has_premium_l1  ? 'TRUE' : 'FALSE';
          x.has_verified_l1          = ent.has_verified_l1 ? 'TRUE' : 'FALSE';
          x.entitlements_fetched_at  = stamp;
        });
        p.has_basic_l1 = ent.has_basic_l1 ? 'TRUE' : 'FALSE';
        audit_('entitlements_refresh', 'player', p.player_id, null,
          { source: 'push_gate', tournaments: ent.tournaments });
      } catch (e) {
        audit_('entitlements_refresh_error', 'player', p.player_id, null,
          { error: String(e && e.message || e) });
        // fall through — use stored value (which means strict gate will block)
      }
    }
    return p;
  };

  // Strict enforcement per DUPR spec — only an explicit TRUE on
  // has_basic_l1 passes. Refresh-if-stale tries to fetch first.
  const missing = [];
  player_ids.forEach(pid => {
    const p = refreshIfStale(pid);
    if (!p) { missing.push(pid + ' (no row)'); return; }
    const explicitlyTrue = p.has_basic_l1 === true || p.has_basic_l1 === 'TRUE';
    if (!explicitlyTrue) {
      const reason = (p.has_basic_l1 === false || p.has_basic_l1 === 'FALSE')
        ? 'BASIC_L1 missing'
        : 'entitlements not verifiable';
      missing.push((p.full_name || pid) + ' (' + reason + ')');
    }
  });
  if (missing.length) {
    throw new Error('Match push blocked — ' + missing.join(', '));
  }
}

/* ============================================================
 * Club integration — verify admin has DIRECTOR/ORGANIZER role
 * before submitting matches with source=CLUB.
 *
 * Endpoint: GET /user/v1.0/{duprId}/clubs (partner-auth)
 * Response shape (per Swagger): array of { clubId, role, ... }
 * ============================================================ */

function duprFetchUserClubs_(duprId) {
  if (!duprId) throw new Error('duprId required');
  const resp = duprFetch_('GET', '/user/v1.0/' + encodeURIComponent(duprId) + '/clubs');
  if (resp.status >= 400) {
    throw new Error('DUPR clubs fetch failed (' + resp.status + '): ' + resp.body_text);
  }
  const result = (resp.body_json && resp.body_json.result) || resp.body_json || [];
  // DUPR's actual shape is { membership: [{clubId, clubName, role}] }
  // but other variants exist; cover all.
  const arr = Array.isArray(result) ? result : (
    result.membership || result.memberships || result.clubs || result.content || []
  );
  return arr.map(c => ({
    // clubId may come back as number or string — coerce to string.
    clubId: String(c.clubId != null ? c.clubId : (c.id != null ? c.id : (c.club_id || c.clubID || ''))).trim(),
    role:   String(c.role || c.membershipRole || c.userRole || c.type || '').toUpperCase(),
    name:   c.name || c.clubName || c.club_name || '',
    _raw:   c,
  }));
}

/**
 * Exchange a stored refreshToken for a new user access token.
 * Endpoint per DUPR support: POST /auth/v1.0/token/refresh on the user
 * API host (api.uat.dupr.gg / api.dupr.gg). Body: { refreshToken }.
 * Returns { accessToken, refreshToken } — the refresh token may rotate.
 */
function duprRefreshUserToken_(refreshToken) {
  if (!refreshToken) throw new Error('refreshToken required');
  const host = _duprUserApiBase_();
  const url = host + '/auth/v1.0/token/refresh';
  const resp = UrlFetchApp.fetch(url, {
    method:  'post',
    headers: {
      'Accept':       'application/json',
      'Content-Type': 'application/json',
    },
    payload: JSON.stringify({ refreshToken: refreshToken }),
    muteHttpExceptions: true,
  });
  const status = resp.getResponseCode();
  const text = resp.getContentText();
  if (status === 401 || status === 403) {
    throw new Error('Refresh token rejected (' + status + ') — re-SSO required: ' + (text || '').slice(0, 200));
  }
  if (status >= 400) {
    throw new Error('Token refresh failed (' + status + '): ' + (text || '').slice(0, 300));
  }
  let json;
  try { json = JSON.parse(text); } catch (e) { throw new Error('Refresh response not JSON: ' + text); }
  const result = json.result || json;
  const accessToken  = result.accessToken  || result.access_token  || result.token || '';
  const rotatedRefresh = result.refreshToken || result.refresh_token || refreshToken;
  if (!accessToken) throw new Error('No accessToken in refresh response: ' + text);
  return { accessToken: accessToken, refreshToken: rotatedRefresh };
}

/**
 * Fetch entitlements for a Players-row object, transparently refreshing the
 * user access token via the stored refresh token if the access token has
 * expired. Persists rotated tokens back to the Players row + audits.
 */
function fetchPlayerEntitlementsWithRefresh_(player) {
  const accessToken  = String(player.dupr_user_token    || '').trim();
  const refreshToken = String(player.dupr_refresh_token || '').trim();
  if (!accessToken && !refreshToken) {
    throw new Error('No tokens on file for ' + (player.full_name || player.player_id) + ' — needs re-SSO');
  }
  // Try with current access token first.
  if (accessToken) {
    try { return duprFetchUserEntitlements_(accessToken); }
    catch (e) {
      const msg = String(e && e.message || e);
      const is401 = /\(401\)/.test(msg) || /token rejected/i.test(msg);
      if (!is401 || !refreshToken) throw e;
      // fall through to refresh
    }
  }
  // Refresh + retry.
  const fresh = duprRefreshUserToken_(refreshToken);
  updateWhere_('Players', p => p.player_id === player.player_id, p => {
    p.dupr_user_token    = fresh.accessToken;
    p.dupr_refresh_token = fresh.refreshToken;
  });
  audit_('user_token_refreshed', 'player', player.player_id, null,
    { rotated_refresh: fresh.refreshToken !== refreshToken });
  player.dupr_user_token    = fresh.accessToken;
  player.dupr_refresh_token = fresh.refreshToken;
  return duprFetchUserEntitlements_(fresh.accessToken);
}

/**
 * Diagnostic: dump the raw /subscription/active response for one player.
 * Run from editor → DuprApi.gs → duprDumpEntitlements → Run → View logs.
 * Looks up that player's user token from the Players sheet automatically.
 */
function duprDumpEntitlements() {
  const DUPR_ID = '';  // ← paste a DUPR ID with a stored userToken (e.g. '6ZGNNG')
  if (!DUPR_ID) { Logger.log('Edit duprDumpEntitlements and paste a DUPR ID.'); return; }
  const p = getObjects_('Players').find(p => String(p.dupr_id || '').trim() === DUPR_ID);
  if (!p) { Logger.log('No Players row for DUPR ID %s', DUPR_ID); return; }
  if (!p.dupr_user_token) { Logger.log('Player %s has no stored dupr_user_token.', DUPR_ID); return; }
  const host = _duprUserApiBase_();
  const url = host + '/subscription/active';
  Logger.log('POST %s', url);
  const resp = UrlFetchApp.fetch(url, {
    method:  'post',
    headers: {
      'Authorization': 'Bearer ' + p.dupr_user_token,
      'Accept':        'application/json',
      'Content-Type':  'application/json',
    },
    payload: '{}',
    muteHttpExceptions: true,
  });
  Logger.log('Status: %s', resp.getResponseCode());
  Logger.log('Body:\n%s', (resp.getContentText() || '').slice(0, 4000));
  return { status: resp.getResponseCode(), body: resp.getContentText() };
}

/**
 * Diagnostic: dump the raw /user/v1.0/me response for one player using their
 * stored SSO token. Shows exactly which name / performance fields DUPR
 * returns in production. Edit DUPR_ID, Run, View logs.
 */
function duprDumpProfileMe() {
  const DUPR_ID = '';  // ← paste a DUPR ID with a stored userToken (e.g. 'WXYK5M')
  if (!DUPR_ID) { Logger.log('Edit duprDumpProfileMe and paste a DUPR ID.'); return; }
  const p = getObjects_('Players').find(p => String(p.dupr_id || '').trim() === DUPR_ID);
  if (!p) { Logger.log('No Players row for DUPR ID %s', DUPR_ID); return; }
  if (!p.dupr_user_token) { Logger.log('Player %s has no stored dupr_user_token.', DUPR_ID); return; }
  const resp = duprFetch_('GET', '/user/v1.0/me', {
    headers: { 'Authorization': 'Bearer ' + p.dupr_user_token },
    no_auth: true, no_retry: true,
  });
  Logger.log('Status: %s', resp.status);
  const result = (resp.body_json && (resp.body_json.result || resp.body_json)) || {};
  Logger.log('Top-level result keys: %s', Object.keys(result).join(', '));
  if (result.performance) Logger.log('performance: %s', JSON.stringify(result.performance));
  if (result.ratings)     Logger.log('ratings: %s', JSON.stringify(result.ratings));
  Logger.log('Full body:\n%s', (resp.body_text || '').slice(0, 5000));
  return resp.body_json;
}

/** Diagnostic: dump raw clubs response. Run from editor with DUPR_ID literal. */
function duprDumpUserClubs() {
  const DUPR_ID = '';  // ← paste DUPR ID to test
  if (!DUPR_ID) { Logger.log('Edit duprDumpUserClubs and paste a DUPR ID.'); return; }
  const resp = duprFetch_('GET', '/user/v1.0/' + encodeURIComponent(DUPR_ID) + '/clubs');
  Logger.log('Status: %s', resp.status);
  Logger.log('Body keys: %s', resp.body_json ? Object.keys(resp.body_json).join(', ') : '(no JSON)');
  Logger.log('Full body:\n%s', (resp.body_text || '').slice(0, 4000));
  return resp;
}

function duprClubConfig_() {
  const p = PropertiesService.getScriptProperties();
  return {
    club_id:        (p.getProperty('DUPR_CLUB_ID')        || '').trim(),
    admin_dupr_id:  (p.getProperty('DUPR_ADMIN_DUPR_ID')  || '').trim(),
  };
}

function duprClubConfigured_() {
  const c = duprClubConfig_();
  return !!c.club_id && !!c.admin_dupr_id;
}

/**
 * Verify the configured admin DUPR user holds DIRECTOR or ORGANIZER role on
 * the configured club. Caches 24h. If the lookup returns no membership or
 * has an unexpected response shape, audit it but DON'T crash — degrade to
 * PARTNER source so matches still push. (UAT often returns less than prod.)
 */
function ensureAdminClubRole_() {
  const cfg = duprClubConfig_();
  if (!cfg.club_id || !cfg.admin_dupr_id) {
    return { configured: false, source: 'PARTNER' };
  }
  const cacheKey = 'dupr_club_role:' + cfg.admin_dupr_id + ':' + cfg.club_id;
  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  let memberships = [];
  try {
    memberships = duprFetchUserClubs_(cfg.admin_dupr_id);
  } catch (e) {
    const result = {
      configured:   true,
      source:       'PARTNER',
      club_id:      cfg.club_id,
      admin_dupr_id: cfg.admin_dupr_id,
      degrade:      'lookup_failed',
      error:        String(e && e.message || e).slice(0, 400),
      verified_at:  nowStamp_(),
    };
    cache.put(cacheKey, JSON.stringify(result), 3600);  // 1h cache for soft errors
    audit_('club_role_lookup_failed', 'club', cfg.club_id, null, { error: result.error });
    return result;
  }

  const match = memberships.find(m => m.clubId === cfg.club_id);
  if (!match || (match.role !== 'DIRECTOR' && match.role !== 'ORGANIZER')) {
    const result = {
      configured:   true,
      source:       'PARTNER',
      club_id:      cfg.club_id,
      admin_dupr_id: cfg.admin_dupr_id,
      degrade:      match ? 'wrong_role' : 'not_member',
      role:         match ? match.role : null,
      memberships_count: memberships.length,
      verified_at:  nowStamp_(),
    };
    cache.put(cacheKey, JSON.stringify(result), 3600);
    audit_('club_role_not_authorized', 'club', cfg.club_id, null, result);
    return result;
  }

  const result = {
    configured:   true,
    source:       'CLUB',
    club_id:      cfg.club_id,
    club_name:    match.name,
    role:         match.role,
    verified_at:  nowStamp_(),
  };
  cache.put(cacheKey, JSON.stringify(result), 24 * 3600);
  audit_('club_role_verified', 'club', cfg.club_id, null, result);
  return result;
}

/** Force a fresh role check, ignoring cache. Useful from the UI button. */
function refreshAdminClubRole_() {
  const cfg = duprClubConfig_();
  if (cfg.club_id && cfg.admin_dupr_id) {
    CacheService.getScriptCache().remove('dupr_club_role:' + cfg.admin_dupr_id + ':' + cfg.club_id);
  }
  return ensureAdminClubRole_();
}

/* ============================================================
 * Match update / delete
 * ============================================================ */

/**
 * Update a previously-pushed match on DUPR with new scores.
 * Requires the game to have been pushed (so we have matchCode + identifier).
 *
 * "If teams, scores, or dates change on an ELO-rated match, ratings will
 *  be reversed and recalculated." — DUPR docs
 */
function duprUpdateMatch_(game_id) {
  const game = getObjects_('Games').find(g => g.game_id === game_id);
  if (!game) throw new Error('Game not found: ' + game_id);
  if (game.status !== 'pushed') throw new Error('Game has not been pushed yet — push it first');
  if (!game.dupr_match_id) throw new Error('Game has no dupr_match_id (matchCode)');

  const players = getObjects_('Players');
  const byId = {};
  players.forEach(p => { byId[p.player_id] = p; });
  const pids = [game.t1_player_1_id, game.t1_player_2_id, game.t2_player_1_id, game.t2_player_2_id];
  const duprs = pids.map(pid => String((byId[pid] || {}).dupr_id || '').trim());
  if (duprs.some(d => !d)) throw new Error('One or more players unlinked — cannot update');

  const clubRoleU = ensureAdminClubRole_();
  const payload = {
    identifier: game_id,
    matchId:    game.dupr_match_id,
    event:      String(game.event_label || 'Dill Dinkers Sandbox'),
    matchDate:  _formatDuprDate_(game.play_date) || _formatDuprDate_(new Date()),
    matchType:  'SIDEOUT',
    scoreType:  'REGULAR',
    format:     'DOUBLES',
    source:     clubRoleU.source,
    teamA: { player1: duprs[0], player2: duprs[1], game1: Number(game.t1_score) },
    teamB: { player1: duprs[2], player2: duprs[3], game1: Number(game.t2_score) },
  };
  if (clubRoleU.source === 'CLUB' && clubRoleU.club_id) payload.clubId = clubRoleU.club_id;

  const resp = duprFetch_('POST', '/match/v1.0/update', { body: payload });
  const ok = resp.status >= 200 && resp.status < 300;
  const respJson = resp.body_json || {};
  const truncate = s => (s || '').toString().slice(0, 4000);
  appendObjects_('DUPR_Push_Log', [{
    push_id:         makeId_('push'),
    game_id:         game_id,
    attempted_at:    nowStamp_(),
    status:          ok ? 'success' : 'error',
    http_status:     resp.status,
    request_payload: truncate(JSON.stringify(payload)),
    response_body:   truncate(resp.body_text),
    dupr_match_id:   game.dupr_match_id,
    error_message:   ok ? '' : truncate((respJson.message || respJson.error || resp.body_text)),
    attempted_by:    activeUserEmail_(),
  }]);
  if (!ok) throw new Error('DUPR update failed (' + resp.status + '): ' + (respJson.message || resp.body_text));
  updateWhere_('Games', g => g.game_id === game_id, g => { g.updated_at = nowStamp_(); });
  audit_('dupr_update_success', 'game', game_id, null, { matchCode: game.dupr_match_id });
  return { ok: true, http_status: resp.status, dupr_match_id: game.dupr_match_id };
}

/**
 * Delete a previously-pushed match on DUPR. Called automatically when a
 * pushed game is voided.
 */
function duprDeleteMatch_(game_id) {
  const game = getObjects_('Games').find(g => g.game_id === game_id);
  if (!game) throw new Error('Game not found: ' + game_id);
  if (!game.dupr_match_id) return { ok: true, skipped: 'no matchCode on game' };

  const payload = {
    identifier: game_id,
    matchCode:  game.dupr_match_id,
  };
  const resp = duprFetch_('DELETE', '/match/v1.0/delete', { body: payload });
  const ok = resp.status >= 200 && resp.status < 300;
  const respJson = resp.body_json || {};
  const truncate = s => (s || '').toString().slice(0, 4000);
  appendObjects_('DUPR_Push_Log', [{
    push_id:         makeId_('push'),
    game_id:         game_id,
    attempted_at:    nowStamp_(),
    status:          ok ? 'success' : 'error',
    http_status:     resp.status,
    request_payload: 'DELETE ' + truncate(JSON.stringify(payload)),
    response_body:   truncate(resp.body_text),
    dupr_match_id:   game.dupr_match_id,
    error_message:   ok ? '' : truncate((respJson.message || respJson.error || resp.body_text)),
    attempted_by:    activeUserEmail_(),
  }]);
  if (!ok) throw new Error('DUPR delete failed (' + resp.status + '): ' + (respJson.message || resp.body_text));
  audit_('dupr_delete_success', 'game', game_id, null, { matchCode: game.dupr_match_id });
  return { ok: true, http_status: resp.status };
}

/* ============================================================
 * Webhook registration (POST /v1.0/webhook)
 *
 * Registers a webhook URL with DUPR for the partner. DUPR will then POST
 * RATING events to that URL as players' ratings change. The URL should be
 * our deployed /exec endpoint — doPost in Web.js handles the receipt.
 *
 * Topics: only 'RATING' is currently supported (per docs).
 * ============================================================ */

function duprRegisterWebhook_(webhookUrl, topics) {
  if (!webhookUrl) throw new Error('webhookUrl required');
  if (!/^https:\/\//.test(webhookUrl)) throw new Error('webhookUrl must be HTTPS');
  const tps = (topics && topics.length) ? topics : ['RATING'];
  const payload = { webhookUrl: webhookUrl, topics: tps };
  const resp = duprFetch_('POST', '/v1.0/webhook', { body: payload });
  if (resp.status >= 400) {
    throw new Error('Webhook register failed (' + resp.status + '): ' + resp.body_text);
  }
  audit_('dupr_webhook_register', 'webhook', webhookUrl, null, { topics: tps, http_status: resp.status });
  return resp.body_json || { ok: true, status: resp.status };
}

function duprListWebhooks_() {
  // Endpoint per Swagger may be GET /v1.0/webhook — try and surface raw result.
  const resp = duprFetch_('GET', '/v1.0/webhook');
  return { status: resp.status, body: resp.body_json || resp.body_text };
}

function _formatDuprDate_(v) {
  if (!v) return '';
  if (v instanceof Date) return Utilities.formatDate(v, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const s = String(v).trim();
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const d = new Date(s);
  if (!isNaN(d.getTime())) return Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  return s;
}

/* ============================================================
 * Diagnostics. Run from the Apps Script editor.
 * ============================================================ */

/** Show the current config (no secrets, just presence + derived bits). */
function duprDescribe() {
  const c = duprConfig_();
  // Surface the raw clientKey value so the user can sanity-check against
  // their DUPR onboarding email. (It's a public identifier embedded in the
  // iframe URL anyway — not a secret.)
  const out = {
    base_url:                  c.base_url || '(unset)',
    sso_base_url:              c.sso_base_url || '(derive failed — set DUPR_SSO_BASE_URL)',
    client_key_value:          c.client_key || '(unset)',
    client_key_came_from:      PropertiesService.getScriptProperties().getProperty('DUPR_CLIENT_KEY')
                                 ? 'DUPR_CLIENT_KEY (explicit)'
                                 : (c.client_key ? 'DUPR_CLIENT_ID (fallback)' : '(unset)'),
    client_secret_set:         !!c.client_secret,
    iframe_url_websafe:        c.client_key ? duprBuildSsoIframeUrl_() : '(client_key unset)',
    iframe_url_standardb64:    c.client_key ? (c.sso_base_url + '/login-external-app/' + Utilities.base64Encode(c.client_key)) : '(n/a)',
  };
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

/** Quick helper to set the SSO clientKey separately from the API client_id. */
function setDuprClientKeyToValue() {
  // Edit, Run, then reset to '' and save.
  const clientKey = '';
  if (!clientKey) throw new Error('Edit setDuprClientKeyToValue and supply a clientKey first.');
  PropertiesService.getScriptProperties().setProperty('DUPR_CLIENT_KEY', clientKey);
  Logger.log('DUPR_CLIENT_KEY set.');
}

/**
 * Dump the raw /user/v1.0/{duprId} response so we can see exactly what
 * fields DUPR returns (and what they're named).
 *
 * Usage from the editor:
 *   1. Edit DUPR_ID literal below to your linked DUPR ID.
 *   2. Function dropdown → duprDumpUser → Run.
 *   3. View → Logs.
 */
function duprDumpUser() {
  const DUPR_ID = '';  // ← paste your DUPR ID (e.g. '6ZGNNG'), Run, view logs
  if (!DUPR_ID) {
    Logger.log('Edit duprDumpUser() and paste a DUPR ID into DUPR_ID first.');
    return;
  }
  const resp = duprFetch_('GET', '/user/v1.0/' + encodeURIComponent(DUPR_ID));
  Logger.log('Status: %s', resp.status);
  Logger.log('Top-level keys: %s', resp.body_json ? Object.keys(resp.body_json).join(', ') : '(no JSON)');
  if (resp.body_json && resp.body_json.result) {
    Logger.log('result keys: %s', Object.keys(resp.body_json.result).join(', '));
  }
  Logger.log('Full body:\n%s', (resp.body_text || '').slice(0, 6000));
  return resp;
}

/** Mint a bearer token and call a lightweight authed endpoint. */
function duprPing() {
  if (!duprConfigured_()) return { ok: false, error: 'not configured — run setDuprCredentialsToValue' };
  try { duprBearerToken_(); } catch (e) {
    Logger.log('Bearer mint failed: %s', e && e.message);
    return { ok: false, error: 'Bearer mint failed: ' + (e && e.message || e) };
  }
  const resp = duprFetch_('GET', '/user/v1.0/me');
  Logger.log('Status: %s\nBody: %s', resp.status, (resp.body_text || '').slice(0, 1000));
  return { status: resp.status, body_preview: (resp.body_text || '').slice(0, 500) };
}
