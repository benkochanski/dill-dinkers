/**
 * doGet router. Pages:
 *
 *   ?page=home                    Admin landing (admin-gated)
 *   ?page=login                   Admin login form
 *   ?page=operator                Score-submit UI (admin-gated)
 *   ?page=link&pid=<player_id>    Player DUPR link page (no admin gate)
 *   ?page=oauth_start&pid=...     Server-side redirect to DUPR authorize
 *   ?page=oauth_cb                DUPR OAuth callback
 *
 * Token convention: admin tokens are passed in the URL as ?t=<token> on
 * server-rendered pages so HTML inline scripts can pass them to api_*
 * calls. The Login page sets it via localStorage too.
 */

function doGet(e) {
  const params = (e && e.parameter) || {};
  const page = (params.page || 'home').toLowerCase();
  try {
    switch (page) {
      case 'login':       return renderLogin_(params);
      case 'link':        return renderLink_(params);
      case 'register':    return renderRegister_(params);
      case 'home':        return renderAdmin_(params, 'Home');
      case 'operator':    return renderAdmin_(params, 'Operator');
      default:            return htmlError_('Unknown page: ' + page);
    }
  } catch (err) {
    return htmlError_(err && err.message ? err.message : String(err));
  }
}

function renderAdmin_(params, label) {
  if (!isAdminTokenValid_(params.t)) {
    // Redirect to login, preserving requested page.
    const t = HtmlService.createTemplateFromFile('Login');
    t.appName     = CONFIG.APP_NAME;
    t.returnPage  = (params.page || 'home').toLowerCase();
    t.appUrl      = ScriptApp.getService().getUrl();
    t.errorMsg    = '';
    return t.evaluate()
      .setTitle(CONFIG.APP_NAME + ' — Sign In')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  if (label === 'Operator') {
    const t = HtmlService.createTemplateFromFile('Operator');
    t.appName = CONFIG.APP_NAME;
    t.token   = params.t || '';
    t.appUrl  = ScriptApp.getService().getUrl();
    return t.evaluate()
      .setTitle(CONFIG.APP_NAME + ' — Operator')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  const t = HtmlService.createTemplateFromFile('Home');
  t.appName = CONFIG.APP_NAME;
  t.token   = params.t || '';
  t.appUrl  = ScriptApp.getService().getUrl();
  return t.evaluate()
    .setTitle(CONFIG.APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function renderLogin_(params) {
  const t = HtmlService.createTemplateFromFile('Login');
  t.appName    = CONFIG.APP_NAME;
  t.returnPage = (params.return_page || 'home').toLowerCase();
  t.appUrl     = ScriptApp.getService().getUrl();
  t.errorMsg   = '';
  return t.evaluate()
    .setTitle(CONFIG.APP_NAME + ' — Sign In')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Public self-service registration. One shared URL anyone can hit:
 *
 *   <exec>?page=register
 *
 * The player fills out their info + completes DUPR SSO inline (iframe +
 * postMessage). On submit, server creates a Players row with the captured
 * dupr_id. No admin token, no per-player link.
 *
 * State nonce protects against replay — same scheme as renderLink_, but
 * the nonce is bound to "registration" rather than to a specific player_id.
 */
function renderRegister_(params) {
  let iframeUrl = '', state = '', startError = '';
  if (duprConfigured_()) {
    try {
      state = Utilities.getUuid();
      // Store a marker so api_completeRegistration can validate the nonce.
      CacheService.getScriptCache().put('dupr_reg_state:' + state, '1', 1800);
      iframeUrl = duprBuildSsoIframeUrl_();
    } catch (e) {
      startError = e && e.message ? e.message : String(e);
    }
  }
  const t = HtmlService.createTemplateFromFile('Register');
  t.appName        = CONFIG.APP_NAME;
  t.appUrl         = ScriptApp.getService().getUrl();
  t.duprConfigured = duprConfigured_();
  t.iframeUrl      = iframeUrl;
  t.state          = state;
  t.startError     = startError;
  return t.evaluate()
    .setTitle(CONFIG.APP_NAME + ' — Register')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function renderLink_(params) {
  const pid = params.pid || '';
  const player = pid ? getObjects_('Players').find(p => p.player_id === pid) : null;
  let iframeUrl = '', state = '', startError = '';
  if (player && duprConfigured_()) {
    try {
      const start = duprStartSsoForPlayer_(pid);
      iframeUrl = start.iframe_url;
      state     = start.state;
    } catch (e) {
      startError = e && e.message ? e.message : String(e);
    }
  }
  const t = HtmlService.createTemplateFromFile('Link');
  t.appName         = CONFIG.APP_NAME;
  t.appUrl          = ScriptApp.getService().getUrl();
  t.playerId        = pid;
  t.playerName      = player ? (player.full_name || '') : '';
  t.alreadyLinked   = !!(player && player.dupr_id);
  t.currentDupr     = player ? (player.dupr_id || '') : '';
  t.notFound        = !!pid && !player;
  t.duprConfigured  = duprConfigured_();
  t.iframeUrl       = iframeUrl;
  t.state           = state;
  t.startError      = startError;
  return t.evaluate()
    .setTitle(CONFIG.APP_NAME + ' — Link DUPR')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * doPost — DUPR webhook receiver. Same /exec URL as doGet; method is POST.
 *
 * Inbound shape:
 *   { clientId, event, message: { duprId, name, token, timestamp,
 *                                  rating: {doubles, singles, ...},
 *                                  metrics: {...} } }
 *
 * Validates clientId matches our DUPR_CLIENT_KEY, applies new doubles
 * rating to Players row by dupr_id, logs every receipt to Webhook_Log.
 * Always returns 200 OK so DUPR doesn't retry on our processing errors.
 */
function doPost(e) {
  const rawText = (e && e.postData && e.postData.contents) || '';
  let payload = null;
  try { payload = JSON.parse(rawText); } catch (err) { payload = null; }

  const event   = (payload && payload.event) || '';
  const msg     = (payload && payload.message) || {};
  const duprId  = String(msg.duprId || '').trim();
  const name    = String(msg.name || '').trim();
  const inboundClientId = String((payload && payload.clientId) || '').trim();

  // Client identity check — DUPR's docs don't specify which of our partner
  // identifiers they put in payload.clientId. Accept any of:
  //   - DUPR_CLIENT_KEY (the test-ck-... value)
  //   - DUPR_CLIENT_ID (the numeric 4907436155)
  //   - base64(clientKey) (URL-safe, unpadded)
  //   - base64(clientKey) (standard with padding)
  const props = PropertiesService.getScriptProperties();
  const ourClientKey = props.getProperty('DUPR_CLIENT_KEY') || '';
  const ourClientId  = props.getProperty('DUPR_CLIENT_ID')  || '';
  const acceptable = [
    ourClientKey,
    ourClientId,
    ourClientKey && Utilities.base64Encode(ourClientKey).replace(/=+$/, ''),
    ourClientKey && Utilities.base64EncodeWebSafe(ourClientKey).replace(/=+$/, ''),
    ourClientId  && Utilities.base64Encode(ourClientId).replace(/=+$/, ''),
  ].filter(Boolean);
  const clientIdOK = !!inboundClientId && acceptable.indexOf(inboundClientId) !== -1;

  const rating  = msg.rating || {};
  const ratingD = rating.doubles == null ? '' : String(rating.doubles);
  const ratingS = rating.singles == null ? '' : String(rating.singles);
  const matchId = rating.matchId == null ? '' : String(rating.matchId);

  let applyStatus;
  let appliedTo = '';

  if (!clientIdOK) {
    applyStatus = 'rejected_bad_client';
  } else if (event === 'REGISTRATION' || event === 'RATING_SEED') {
    // DUPR's test/seed pings — no duprId, no rating to apply. Just ack.
    applyStatus = 'ack';
  } else if (!duprId) {
    applyStatus = 'skipped_no_dupr_id';
  } else {
    const player = getObjects_('Players').find(p => String(p.dupr_id || '').trim() === duprId);
    if (player) {
      const before = Object.assign({}, player);
      updateWhere_('Players',
        p => p.player_id === player.player_id,
        p => {
          // Update CURRENT columns only — registration rating is immutable.
          if (ratingD !== '') p.dupr_doubles_rating_current = ratingD;
          if (rating.doublesReliability != null) {
            p.dupr_doubles_reliability_score_current = Number(rating.doublesReliability);
          }
          if (rating.doublesProvisional != null) {
            p.dupr_doubles_reliable_current = (Number(rating.doublesProvisional) === 0) ? 'TRUE' : 'FALSE';
          }
          p.dupr_doubles_current_updated_at = nowStamp_();
          p.dupr_stats_fetched_at           = nowStamp_();
        });
      applyStatus = 'applied';
      appliedTo   = player.player_id;
      audit_('webhook_rating_applied', 'player', player.player_id, before, {
        rating_doubles: ratingD, match_id: matchId
      });
    } else {
      applyStatus = 'skipped_no_match';
    }
  }

  try {
    appendObjects_('Webhook_Log', [{
      webhook_id:           makeId_('audit'),
      received_at:          nowStamp_(),
      event:                event,
      dupr_id:              duprId,
      name:                 name,
      client_id_match:      clientIdOK ? 'TRUE' : 'FALSE',
      rating_doubles:       ratingD,
      rating_singles:       ratingS,
      match_id:             matchId,
      applied_to_player_id: appliedTo,
      apply_status:         applyStatus,
      raw_payload:          (rawText || '').slice(0, 4000),
    }]);
  } catch (logErr) { /* swallow — never fail the webhook on our logging */ }

  // Always 200 — DUPR will not retry on our processing errors.
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, status: applyStatus }))
    .setMimeType(ContentService.MimeType.JSON);
}

function htmlError_(msg) {
  return HtmlService.createHtmlOutput(
    '<!doctype html><meta charset=utf-8><title>Error</title>' +
    '<body style="font-family:system-ui;padding:40px;max-width:520px;margin:auto">' +
    '<h1>Error</h1><p>' + escapeHtml_(msg) + '</p></body>'
  );
}

function escapeHtml_(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function include_(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

function getAppUrl() {
  return ScriptApp.getService().getUrl();
}
