/**
 * Player roster management.
 *
 * Players (master) is global. Rosters connects a Player to a League with an
 * optional team_id (partner) or null (ladder). One roster row per
 * league × player. status in {active, inactive} for in-season removals.
 */

/**
 * Find or create a player by email. Email is the unique key.
 * If a player exists with the email, this updates any provided fields.
 */
function upsertPlayer_(input) {
  const email = (input.email || '').toLowerCase().trim();
  if (!email && !input.full_name) throw new Error('Need at least email or full_name');

  const all = getObjects_('Players');
  const existing = email ? all.find(p => (p.email || '').toLowerCase() === email) : null;

  if (existing) {
    const before = Object.assign({}, existing);
    updateWhere_('Players', p => p.player_id === existing.player_id, p => {
      ['full_name', 'first_name', 'last_name', 'phone', 'gender', 'dupr_id',
       'club_member_id', 'level', 'notes'].forEach(k => {
        if (input[k] !== undefined && input[k] !== '') p[k] = input[k];
      });
    });
    audit_('player_update', 'player', existing.player_id, before, input);
    return getObjects_('Players').find(p => p.player_id === existing.player_id);
  }

  const player_id = makeId_('player');
  const fullName = input.full_name || '';
  const parts = fullName.trim().split(/\s+/);
  const player = {
    player_id:      player_id,
    full_name:      fullName,
    first_name:     input.first_name || (parts.length ? parts[0] : ''),
    last_name:      input.last_name  || (parts.length > 1 ? parts.slice(1).join(' ') : ''),
    email:          email,
    phone:          input.phone || '',
    gender:         input.gender || '',
    dupr_id:        input.dupr_id || '',
    club_member_id: input.club_member_id || '',
    level:          input.level || '',
    active:         input.active === false ? false : true,
    notes:          input.notes || '',
    created_at:     nowStamp_(),
  };
  appendObjects_('Players', [player]);
  audit_('player_create', 'player', player_id, null, { email: email, full_name: fullName });
  return player;
}

function findPlayerByEmail_(email) {
  if (!email) return null;
  const e = String(email).toLowerCase().trim();
  return getObjects_('Players').find(p => (p.email || '').toLowerCase() === e) || null;
}

function findPlayerByName_(fullName) {
  if (!fullName) return null;
  const n = String(fullName).toLowerCase().trim();
  return getObjects_('Players').find(p => (p.full_name || '').toLowerCase().trim() === n) || null;
}

/**
 * Add a player to a league's roster. Idempotent — returns the existing
 * roster row if already present.
 */
function addToRoster_(league_id, player_id, opts) {
  if (!league_id || !player_id) throw new Error('league_id and player_id required');
  opts = opts || {};
  const existing = getObjects_('Rosters')
    .find(r => r.league_id === league_id && r.player_id === player_id);
  if (existing) return existing;

  const row = {
    roster_id: makeId_('roster'),
    league_id: league_id,
    player_id: player_id,
    team_id:   opts.team_id || '',
    level:     opts.level || '',
    status:    opts.status || 'active',
    added_at:  nowStamp_(),
    added_by:  activeUserEmail_(),
  };
  appendObjects_('Rosters', [row]);
  audit_('roster_add', 'roster', row.roster_id, null, { league_id, player_id });
  return row;
}

function removeFromRoster_(league_id, player_id) {
  const before = getObjects_('Rosters')
    .find(r => r.league_id === league_id && r.player_id === player_id);
  if (!before) return false;
  updateWhere_('Rosters',
    r => r.league_id === league_id && r.player_id === player_id,
    r => { r.status = 'inactive'; });
  audit_('roster_remove', 'roster', before.roster_id, before.status, 'inactive');
  return true;
}

function listRoster_(league_id, opts) {
  opts = opts || {};
  const rosters = getObjects_('Rosters').filter(r => r.league_id === league_id);
  const filtered = opts.includeInactive ? rosters : rosters.filter(r => r.status === 'active');
  const players = getObjects_('Players');
  const byId = {};
  players.forEach(p => { byId[p.player_id] = p; });
  return filtered.map(r => Object.assign({}, byId[r.player_id] || {}, {
    roster_id: r.roster_id,
    league_id: r.league_id,
    team_id:   r.team_id,
    roster_status: r.status,
    roster_level:  r.level,
  }));
}

/** Partner-only: create a 2-player team in a league. */
function createTeam_(league_id, team_name, player_1_id, player_2_id) {
  if (!league_id || !team_name) throw new Error('league_id and team_name required');
  if (!player_1_id || !player_2_id) throw new Error('two player_ids required');
  const team_id = makeId_('team');
  appendObjects_('Teams', [{
    team_id: team_id,
    league_id: league_id,
    team_name: team_name,
    player_1_id: player_1_id,
    player_2_id: player_2_id,
    created_at: nowStamp_(),
  }]);
  // Auto-roster both players to this team.
  addToRoster_(league_id, player_1_id, { team_id });
  addToRoster_(league_id, player_2_id, { team_id });
  audit_('team_create', 'team', team_id, null, { league_id, team_name, player_1_id, player_2_id });
  return team_id;
}

function listTeams_(league_id) {
  return getObjects_('Teams').filter(t => t.league_id === league_id);
}
