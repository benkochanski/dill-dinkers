/**
 * Role lookup for the web app. Every doGet handler should call
 * requireRole_(e, ['admin']) (or similar) up top.
 */

function getCurrentUser_() {
  const email = activeUserEmail_();
  if (!email) return { email: '', roles: [], isAdmin: false };
  const rows = getObjects_('Roles').filter(r => r.email === email && r.active === true);
  const roles = rows.map(r => r.role);
  return {
    email: email,
    roles: roles,
    isAdmin: roles.indexOf('admin') !== -1,
    rows: rows,  // keep the scoped rows so callers can check league_id / team_id
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
