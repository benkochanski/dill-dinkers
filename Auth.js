/**
 * Role lookup for the web app. Every doGet handler should call
 * requireRole_(e, ['admin']) (or similar) up top.
 */

function getCurrentUser_() {
  const email = (activeUserEmail_() || '').toLowerCase().trim();
  if (!email) return { email: '', roles: [], isAdmin: false, rows: [] };
  const rows = getObjects_('Roles').filter(r => {
    const e = String(r.email || '').toLowerCase().trim();
    const active = r.active === true || String(r.active).toUpperCase() === 'TRUE';
    return e === email && active;
  });
  const roles = rows.map(r => r.role);

  // Bootstrap escape hatch: if the Roles tab is empty (e.g. the deployer
  // hit the web app before running bootstrap), treat any signed-in user
  // as admin so they can finish setup. As soon as ANY Role row exists,
  // this fallback turns off.
  const allRoles = getObjects_('Roles');
  const fallbackAdmin = allRoles.length === 0;

  return {
    email: email,
    roles: roles.length ? roles : (fallbackAdmin ? ['admin'] : []),
    isAdmin: roles.indexOf('admin') !== -1 || fallbackAdmin,
    rows: rows,
    fallbackAdmin: fallbackAdmin,
  };
}

function userHasRole_(user, role, scopeLeagueId, scopeTeamId) {
  if (!user || !user.rows) return false;
  if (user.isAdmin) return true;
  return user.rows.some(r => {
    if (r.role !== role) return false;
    if (scopeLeagueId && r.scope_league_id && r.scope_league_id !== scopeLeagueId) return false;
    if (scopeTeamId   && r.scope_team_id   && r.scope_team_id   !== scopeTeamId)   return false;
    return true;
  });
}

function requireRole_(user, allowedRoles, scopeLeagueId, scopeTeamId) {
  const ok = allowedRoles.some(role => userHasRole_(user, role, scopeLeagueId, scopeTeamId));
  if (!ok) {
    throw new Error('Forbidden: ' + (user.email || 'anonymous') +
                    ' lacks role ' + allowedRoles.join('|'));
  }
}
