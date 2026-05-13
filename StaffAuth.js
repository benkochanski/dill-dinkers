/**
 * Simple password gate for the staff web app.
 *
 * The web app is deployed with "Anyone, even anonymous" access (no Google
 * sign-in). Staff-facing pages (home, admin, operator, league, display,
 * player) are gated behind a single shared password stored as a SHA-256
 * hash in Script Properties. Public endpoints (json, standings) stay open.
 *
 * Setup:
 *   1. Open the Apps Script editor for this project.
 *   2. Open StaffAuth.js, edit the literal in setStaffPasswordToValue() to
 *      your chosen password.
 *   3. Run setStaffPasswordToValue from the function dropdown.
 *   4. Re-edit the literal to 'CHANGE_ME' and save (so the password isn't
 *      sitting in the source).
 *
 * Token lifetime is 12 hours. Sessions are stored in CacheService, so they
 * naturally expire and can be invalidated by clearing the cache.
 */

const STAFF_PASSWORD_PROP = 'STAFF_PASSWORD_HASH';
const STAFF_TOKEN_TTL_SECONDS = 12 * 3600;
const STAFF_TOKEN_PREFIX = 'staff_token:';

function setStaffPasswordToValue() {
  // EDIT THIS, then Run from the Apps Script editor. Reset to 'CHANGE_ME'
  // after running so the plain password isn't checked into git.
  setStaffPassword_('CHANGE_ME');
}

function setStaffPassword_(plain) {
  if (!plain || String(plain).length < 4) throw new Error('Password must be at least 4 characters');
  if (String(plain) === 'CHANGE_ME') throw new Error('Edit setStaffPasswordToValue to your actual password before running');
  const hash = hashStaffPassword_(String(plain));
  PropertiesService.getScriptProperties().setProperty(STAFF_PASSWORD_PROP, hash);
  return { ok: true };
}

function staffLogin_(password) {
  const storedHash = PropertiesService.getScriptProperties().getProperty(STAFF_PASSWORD_PROP);
  if (!storedHash) throw new Error('Staff password not configured. Run setStaffPasswordToValue from the Apps Script editor.');
  const inputHash = hashStaffPassword_(String(password || ''));
  if (inputHash !== storedHash) {
    Utilities.sleep(400);
    throw new Error('Incorrect password');
  }
  const token = Utilities.getUuid();
  CacheService.getScriptCache().put(STAFF_TOKEN_PREFIX + token, '1', STAFF_TOKEN_TTL_SECONDS);
  return { token: token, expires_in: STAFF_TOKEN_TTL_SECONDS };
}

function staffLogout_(token) {
  if (token) CacheService.getScriptCache().remove(STAFF_TOKEN_PREFIX + String(token));
  return { ok: true };
}

function isStaffTokenValid_(token) {
  if (!token) return false;
  return CacheService.getScriptCache().get(STAFF_TOKEN_PREFIX + String(token)) === '1';
}

function hashStaffPassword_(plain) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, plain, Utilities.Charset.UTF_8);
  return Utilities.base64Encode(digest);
}
