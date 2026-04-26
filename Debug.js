/**
 * One-off diagnostics. Safe to run from the editor at any time.
 */

/** Logs what the script sees about the current user. */
function whoami() {
  const email = activeUserEmail_();
  const user = getCurrentUser_();
  const allRoles = getObjects_('Roles');
  const out = {
    activeUserEmail: email,
    seen_email: user.email,
    matched_role_rows: user.rows,
    roles: user.roles,
    isAdmin: user.isAdmin,
    fallbackAdmin: user.fallbackAdmin,
    all_roles_in_sheet: allRoles,
  };
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

/** Adds the running user to Roles as admin. Idempotent. */
function makeMeAdmin() {
  const me = (activeUserEmail_() || '').toLowerCase().trim();
  if (!me) throw new Error('Could not detect your email — Session.getActiveUser().getEmail() returned empty.');
  const all = getObjects_('Roles');
  const existing = all.find(r =>
    String(r.email || '').toLowerCase().trim() === me && r.role === 'admin');
  if (existing) {
    updateWhere_('Roles',
      r => String(r.email||'').toLowerCase().trim() === me && r.role === 'admin',
      r => { r.active = true; });
    Logger.log('Already admin — re-activated. Email: %s', me);
    return existing;
  }
  const row = {
    email: me, role: 'admin', scope_league_id: '', scope_team_id: '',
    active: true, notes: 'Added by makeMeAdmin', created_at: nowStamp_(),
  };
  appendObjects_('Roles', [row]);
  Logger.log('Added admin role for %s', me);
  return row;
}
