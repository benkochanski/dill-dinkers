/**
 * Roles management — separate from Auth.js so the admin UI has clean CRUD
 * helpers. Auth.js stays focused on per-request role lookup.
 */

const VALID_ROLES = ['admin', 'operator', 'captain'];

function listRoles_() {
  return getObjects_('Roles');
}

function addRole_(input) {
  const email = String(input.email || '').toLowerCase().trim();
  if (!email) throw new Error('email required');
  if (VALID_ROLES.indexOf(input.role) === -1) throw new Error('role must be one of ' + VALID_ROLES.join('|'));

  // De-dupe: if a row exists for (email, role, scope), reactivate it.
  const all = getObjects_('Roles');
  const dup = all.find(r =>
    String(r.email || '').toLowerCase().trim() === email &&
    r.role === input.role &&
    String(r.scope_league_id || '') === String(input.scope_league_id || '') &&
    String(r.scope_team_id   || '') === String(input.scope_team_id   || ''));

  if (dup) {
    updateWhere_('Roles',
      r => String(r.email||'').toLowerCase().trim() === email &&
           r.role === input.role &&
           String(r.scope_league_id || '') === String(input.scope_league_id || '') &&
           String(r.scope_team_id   || '') === String(input.scope_team_id   || ''),
      r => { r.active = true; if (input.notes) r.notes = input.notes; });
    audit_('role_reactivate', 'role', dup.email + ':' + dup.role, false, true);
    return Object.assign({}, dup, { active: true });
  }

  const row = {
    email:           email,
    role:            input.role,
    scope_league_id: input.scope_league_id || '',
    scope_team_id:   input.scope_team_id || '',
    active:          input.active === false ? false : true,
    notes:           input.notes || '',
    created_at:      nowStamp_(),
  };
  appendObjects_('Roles', [row]);
  cacheBust_('roles:list');
  audit_('role_add', 'role', email + ':' + input.role, null, row);
  return row;
}

function deactivateRole_(email, role, scope_league_id, scope_team_id) {
  const e = String(email || '').toLowerCase().trim();
  let touched = 0;
  updateWhere_('Roles', r => {
    return String(r.email || '').toLowerCase().trim() === e &&
           r.role === role &&
           String(r.scope_league_id || '') === String(scope_league_id || '') &&
           String(r.scope_team_id   || '') === String(scope_team_id   || '') &&
           r.active === true;
  }, r => { r.active = false; touched++; });
  if (touched) {
    cacheBust_('roles:list');
    audit_('role_deactivate', 'role', e + ':' + role, true, false);
  }
  return touched;
}

function recentAuditLog_(limit) {
  const lim = Math.max(1, Math.min(Number(limit) || 100, 500));
  const all = getObjects_('Audit_Log');
  return all.slice(-lim).reverse();
}
