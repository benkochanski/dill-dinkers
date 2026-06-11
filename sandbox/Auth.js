/**
 * Single test-admin auth.
 *
 * The web app is published "Anyone, even anonymous" (no Google sign-in).
 * The Operator and DUPR-push UIs are gated behind a single email+password
 * stored as a SHA-256 hash in Script Properties (see Bootstrap.js
 * setAdminPasswordToValue). On successful login a token is issued and
 * persisted in the Admin_Sessions tab (and mirrored in CacheService for
 * fast validation). Tokens last 12 hours.
 *
 * The DUPR Link page is intentionally NOT gated — players reach it via a
 * per-player share link and the SSO flow proves identity.
 */

const ADMIN_TOKEN_TTL_SECONDS = 12 * 3600;
const ADMIN_TOKEN_CACHE_PREFIX = 'admin_session:';

// Populated per request by isAdminTokenValid_. Apps Script V8 starts a fresh
// JS context per execution so this naturally resets. activeUserEmail_ in
// Utils.js prefers it over Session.getActiveUser() so audit rows attribute
// actions to the admin who logged in via our password gate, not the Google
// account in the browser.
var _CURRENT_ADMIN_EMAIL = '';

function adminLogin_(email, password) {
  const props = PropertiesService.getScriptProperties();
  const targetEmail = (props.getProperty('ADMIN_EMAIL') || '').toLowerCase().trim();
  const storedHash = props.getProperty('ADMIN_PASSWORD_HASH');
  if (!targetEmail || !storedHash) {
    throw new Error('Admin credentials not configured. Run setAdminPasswordToValue.');
  }
  const inputEmail = String(email || '').toLowerCase().trim();
  const inputHash = hashPassword_(String(password || ''));
  if (inputEmail !== targetEmail || inputHash !== storedHash) {
    Utilities.sleep(400);  // tiny timing-attack mitigation
    throw new Error('Invalid email or password');
  }
  const token = Utilities.getUuid();
  const expiresAt = Date.now() + ADMIN_TOKEN_TTL_SECONDS * 1000;
  appendObjects_('Admin_Sessions', [{
    token: token,
    email: targetEmail,
    created_at: nowStamp_(),
    expires_at: expiresAt,
  }]);
  CacheService.getScriptCache().put(ADMIN_TOKEN_CACHE_PREFIX + token, targetEmail, ADMIN_TOKEN_TTL_SECONDS);
  audit_('admin_login', 'session', token, null, { email: targetEmail });
  return { token: token, expires_in: ADMIN_TOKEN_TTL_SECONDS, email: targetEmail };
}

function adminLogout_(token) {
  if (!token) return { ok: true };
  CacheService.getScriptCache().remove(ADMIN_TOKEN_CACHE_PREFIX + token);
  // Mark expired in the sheet (instead of deleting, for audit trail).
  updateWhere_('Admin_Sessions',
    s => s.token === token,
    s => { s.expires_at = Date.now() - 1; });
  audit_('admin_logout', 'session', token, null, null);
  return { ok: true };
}

function isAdminTokenValid_(token) {
  if (!token) return false;
  const cached = CacheService.getScriptCache().get(ADMIN_TOKEN_CACHE_PREFIX + token);
  if (cached) {
    _CURRENT_ADMIN_EMAIL = (cached !== '1') ? cached : '';
    return true;
  }
  // Cache miss — check the sheet (covers cross-instance / past-cache-TTL cases).
  const row = getObjects_('Admin_Sessions').find(s => s.token === token);
  if (!row) return false;
  const exp = Number(row.expires_at);
  if (!exp || exp < Date.now()) return false;
  // Repopulate cache + stash email for this request.
  const email = row.email || '';
  const remaining = Math.max(60, Math.floor((exp - Date.now()) / 1000));
  CacheService.getScriptCache().put(ADMIN_TOKEN_CACHE_PREFIX + token, email || '1', Math.min(ADMIN_TOKEN_TTL_SECONDS, remaining));
  _CURRENT_ADMIN_EMAIL = email;
  return true;
}

function requireAdmin_(token) {
  if (!isAdminTokenValid_(token)) throw new Error('Admin login required');
}
