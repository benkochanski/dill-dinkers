/**
 * Web app entry point. Routes by ?page=... .
 *
 * Pages will be filled in over the week. Today: a stub home page that
 * confirms the user's identity and roles.
 */
function doGet(e) {
  const params = (e && e.parameter) || {};
  const page = (params.page || 'home').toLowerCase();
  const user = getCurrentUser_();
  switch (page) {
    case 'home':     return renderHome_(user);
    case 'admin':    return renderAdmin_(user, params);
    case 'operator': return renderOperator_(user, params);
    case 'display':  return renderDisplay_(user, params);
    case 'player':   return renderPlayer_(user, params);
    default:         return htmlError_('Unknown page: ' + page);
  }
}

function renderHome_(user) {
  const t = HtmlService.createTemplateFromFile('Home');
  t.user = user;
  t.appName = CONFIG.APP_NAME;
  return t.evaluate()
    .setTitle(CONFIG.APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function renderAdmin_(user, params)     { return htmlStub_('Admin',    user); }
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
