/**
 * Web app entry point. Routes by ?page=... .
 *
 * Pages will be filled in over the week. Today: a stub home page that
 * confirms the user's identity and roles.
 */
function doGet(e) {
  const params = (e && e.parameter) || {};
  const page = (params.page || 'home').toLowerCase();
  // Public, no-auth endpoints.
  if (page === 'json') return renderJson_(params);
  if (page === 'standings') return renderStandings_(getCurrentUser_(), params);
  // Everything else is staff-only — password gate.
  if (!isStaffTokenValid_(params.t)) return renderLogin_(params);
  const user = getCurrentUser_();
  switch (page) {
    case 'home':      return renderHome_(user);
    case 'admin':     return renderAdmin_(user, params);
    case 'league':    return renderLeagueAdmin_(user, params);
    case 'operator':  return renderOperator_(user, params);
    case 'display':   return renderDisplay_(user, params);
    case 'player':    return renderPlayer_(user, params);
    default:          return htmlError_('Unknown page: ' + page);
  }
}

function renderLogin_(params, errorMessage) {
  const t = HtmlService.createTemplateFromFile('Login');
  t.appName = CONFIG.APP_NAME;
  t.returnPage = (params.page || 'home').toLowerCase();
  const passthrough = {};
  Object.keys(params).forEach(k => {
    if (k !== 't' && k !== 'page' && k !== 'password' && k !== 'action' && k !== 'return_page' && k !== 'return_params') {
      passthrough[k] = params[k];
    }
  });
  t.returnParams = JSON.stringify(passthrough);
  t.errorMessage = errorMessage || '';
  t.appUrl = ScriptApp.getService().getUrl();
  return t.evaluate()
    .setTitle(CONFIG.APP_NAME + ' — Sign In')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}


function renderJson_(params) {
  let body;
  try {
    const data = publicJsonRouter_(params);
    body = JSON.stringify({ ok: true, data: JSON.parse(JSON.stringify(data)) });
  } catch (err) {
    body = JSON.stringify({ ok: false, error: String(err && err.message || err) });
  }
  return ContentService.createTextOutput(body)
    .setMimeType(ContentService.MimeType.JSON);
}

function renderHome_(user) {
  const t = HtmlService.createTemplateFromFile('Home');
  t.user = user;
  t.appName = CONFIG.APP_NAME;
  return t.evaluate()
    .setTitle(CONFIG.APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function renderAdmin_(user, params) {
  const t = HtmlService.createTemplateFromFile('Admin');
  t.user = user;
  t.appName = CONFIG.APP_NAME;
  return t.evaluate()
    .setTitle(CONFIG.APP_NAME + ' — Admin')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
function renderOperator_(user, params)  {
  const t = HtmlService.createTemplateFromFile('Operator');
  t.user = user;
  t.appName = CONFIG.APP_NAME;
  return t.evaluate()
    .setTitle(CONFIG.APP_NAME + ' — Operator')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
function renderDisplay_(user, params)   {
  const t = HtmlService.createTemplateFromFile('Display');
  t.user = user;
  t.appName = CONFIG.APP_NAME;
  return t.evaluate()
    .setTitle(CONFIG.APP_NAME + ' — Display')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
function renderStandings_(user, params) {
  const t = HtmlService.createTemplateFromFile('Public');
  t.user = user;
  t.appName = CONFIG.APP_NAME;
  return t.evaluate()
    .setTitle(CONFIG.APP_NAME + ' — Standings')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
function renderLeagueAdmin_(user, params) {
  const t = HtmlService.createTemplateFromFile('LeagueAdmin');
  t.user = user;
  t.appName = CONFIG.APP_NAME;
  // Apps Script reserves `?id=` internally for its own routing — that param
  // never reaches e.parameter. Use `?lid=` (with `?league_id=` as alias).
  t.leagueId = params.lid || params.league_id || '';
  t.subTab   = (params.tab || 'players').toLowerCase();
  return t.evaluate()
    .setTitle(CONFIG.APP_NAME + ' — League Admin')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
function renderPlayer_(user, params)    { return htmlStub_('Player',   user); }

function htmlStub_(label, user) {
  const html = '<!doctype html><meta charset=utf-8><title>' + label + '</title>' +
    '<body style="font-family:system-ui;padding:24px">' +
    '<h1>' + label + '</h1>' +
    '<p>Stub. ' + (user.email || 'anonymous') +
    ' — roles: ' + (user.roles.join(', ') || 'none') + '</p>' +
    '<p><a href="?page=home">Home</a></p>' +
    '</body>';
  return HtmlService.createHtmlOutput(html)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function htmlError_(msg) {
  return HtmlService.createHtmlOutput(
    '<!doctype html><meta charset=utf-8><title>Error</title>' +
    '<body style="font-family:system-ui;padding:24px">' +
    '<h1>Error</h1><p>' + escapeHtml_(msg) + '</p></body>'
  );
}

function escapeHtml_(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function include_(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/**
 * Returns the deployed web-app URL so client-side nav can drive the outer
 * (script.google.com) frame rather than the inner googleusercontent.com iframe.
 *
 * NOT cached — `/dev` and `/exec` are different deployments of the same
 * script, and a CacheService hit populated by one would be served to the
 * other, resulting in nav links pointing at the wrong deployment. Clients
 * also try to derive the URL from `document.referrer` first, so this server
 * call is just a fallback path.
 */
function getAppUrl() {
  return ScriptApp.getService().getUrl();
}
