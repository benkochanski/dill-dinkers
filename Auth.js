/**
 * Role lookup for the web app. Every doGet handler should call
 * requireRole_(e, ['admin']) (or similar) up top.
 */

function getCurrentUser_() {
  // Open-access mode: every visitor (signed in or anonymous) gets full admin.
  // The web app is published with access=ANYONE_ANONYMOUS, so no Google login
  // is required. Roles tab is no longer enforced — kept for audit-trail labels.
  const email = (activeUserEmail_() || '').toLowerCase().trim();
  return {
    email:    email || 'anonymous',
    roles:    ['admin'],
    isAdmin:  true,
    rows:     [],
    openAccess: true,
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
