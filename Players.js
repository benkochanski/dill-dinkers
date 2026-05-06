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
  cacheBust_('league:' + league_id + ':full');
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
  cacheBust_('league:' + league_id + ':full');
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
  cacheBust_('league:' + league_id + ':full');
  audit_('team_create', 'team', team_id, null, { league_id, team_name, player_1_id, player_2_id });
  return team_id;
}

function listTeams_(league_id) {
  return getObjects_('Teams').filter(t => t.league_id === league_id);
}

/**
 * Rename a team. Idempotent. Audited.
 */
function renameTeam_(team_id, new_name) {
  const name = String(new_name || '').trim();
  if (!name) throw new Error('team_name cannot be blank');
  const before = getObjects_('Teams').find(t => t.team_id === team_id);
  if (!before) throw new Error('Team not found: ' + team_id);
  if (before.team_name === name) return before;
  updateWhere_('Teams', t => t.team_id === team_id, t => { t.team_name = name; });
  cacheBust_('league:' + before.league_id + ':full');
  audit_('team_rename', 'team', team_id, before.team_name, name);
  return getObjects_('Teams').find(t => t.team_id === team_id);
}

/**
 * Replace the two players on a team. Either id can be left blank.
 * Also keeps Rosters.team_id in sync: removes mapping for any old player
 * not in the new pair, and ensures both new players have rosters mapped.
 */
function setTeamPlayers_(team_id, player_1_id, player_2_id) {
  const team = getObjects_('Teams').find(t => t.team_id === team_id);
  if (!team) throw new Error('Team not found: ' + team_id);
  const before = Object.assign({}, team);

  updateWhere_('Teams', t => t.team_id === team_id, t => {
    t.player_1_id = player_1_id || '';
    t.player_2_id = player_2_id || '';
  });

  // Sync Rosters: any prior player not in the new pair gets team_id cleared.
  const newSet = new Set([player_1_id, player_2_id].filter(Boolean));
  const oldSet = [before.player_1_id, before.player_2_id].filter(Boolean);
  oldSet.forEach(pid => {
    if (!newSet.has(pid)) {
      updateWhere_('Rosters',
        r => r.league_id === team.league_id && r.player_id === pid,
        r => { r.team_id = ''; });
    }
  });
  // Ensure both new players have a roster row mapped to this team.
  newSet.forEach(pid => {
    const existing = getObjects_('Rosters')
      .find(r => r.league_id === team.league_id && r.player_id === pid);
    if (existing) {
      updateWhere_('Rosters',
        r => r.roster_id === existing.roster_id,
        r => { r.team_id = team_id; });
    } else {
      addToRoster_(team.league_id, pid, { team_id });
    }
  });

  cacheBust_('league:' + team.league_id + ':full');
  audit_('team_set_players', 'team', team_id, before, { player_1_id, player_2_id });
  return getObjects_('Teams').find(t => t.team_id === team_id);
}

/**
 * Validate that every player on every team in a league has a DUPR ID.
 * Returns an array of issues — each { team_id, team_name, player_id?, issue }.
 */
function validateTeamsForDupr_(league_id) {
  const teams = listTeams_(league_id);
  const players = getObjects_('Players');
  const byId = {};
  players.forEach(p => { byId[p.player_id] = p; });
  const issues = [];
  teams.forEach(t => {
    [['player_1_id', 'P1'], ['player_2_id', 'P2']].forEach(([k, label]) => {
      const pid = t[k];
      if (!pid) {
        issues.push({ team_id: t.team_id, team_name: t.team_name, slot: label, issue: 'no player' });
        return;
      }
      const p = byId[pid];
      if (!p) {
        issues.push({ team_id: t.team_id, team_name: t.team_name, slot: label, player_id: pid, issue: 'player record missing' });
      } else if (!p.dupr_id) {
        issues.push({ team_id: t.team_id, team_name: t.team_name, slot: label, player_id: pid, player_name: p.full_name, issue: 'no DUPR ID' });
      }
    });
  });
  return issues;
}

/**
 * Find or create a team by name in a league. Slot the player into P1 if
 * open, else P2. Errors if the team already has 2 different players.
 */
function slotIntoTeam_(league_id, team_name, player_id) {
  const teams = listTeams_(league_id);
  const name = String(team_name).trim();
  const lower = name.toLowerCase();
  let team = teams.find(t => String(t.team_name).trim().toLowerCase() === lower);

  if (!team) {
    const team_id = makeId_('team');
    appendObjects_('Teams', [{
      team_id:     team_id,
      league_id:   league_id,
      team_name:   name,
      player_1_id: player_id,
      player_2_id: '',
      created_at:  nowStamp_(),
    }]);
    audit_('team_create', 'team', team_id, null, { league_id, team_name: name, player_1_id: player_id });
    return team_id;
  }

  if (team.player_1_id === player_id || team.player_2_id === player_id) return team.team_id;
  if (!team.player_1_id) {
    updateWhere_('Teams', t => t.team_id === team.team_id, t => { t.player_1_id = player_id; });
  } else if (!team.player_2_id) {
    updateWhere_('Teams', t => t.team_id === team.team_id, t => { t.player_2_id = player_id; });
  } else {
    throw new Error('Team "' + name + '" already has 2 players');
  }
  return team.team_id;
}

/**
 * Ladder-format equivalent of `setupTeamsFromCR_` / `bulkRebuildLeagueFromCR_`.
 *
 * Reads CR_Attendance rows whose event_name matches this league (after
 * normalization) and whose registration_type is a "Full" type (full-season
 * registrants, NOT drop-ins / guests / single-session). Dedupes by
 * member_number. For each unique attendee:
 *   - Find the matching Player by club_member_id. Create one if missing.
 *   - Add to Rosters if not already.
 *
 * Idempotent — re-running picks up newly-attended members without duplicating
 * existing Players or Roster rows. Players are NOT removed if they stop
 * appearing in attendance (admin removes via the legacy roster tools).
 *
 * @returns {{ total_attendees, players_added, rosters_added }}
 */
function syncLadderRosterFromAttendance_(league_id) {
  const league = getLeagueById_(league_id);
  if (!league) throw new Error('League not found: ' + league_id);

  const targetName = (league.name || '').trim();
  const isFullEventType = (t) => {
    const s = String(t || '').trim().toLowerCase();
    if (!s) return false;
    if (/drop[\s-]*in|single[\s-]*session|guest|trial/.test(s)) return false;
    return /^full\b|^season\b|^league\b/.test(s);
  };

  const attendance = getObjects_('CR_Attendance').filter(a =>
    _crEventNameMatches_(a.event_name, targetName) &&
    isFullEventType(a.registration_type)
  );

  // Dedupe by member_number — one player can have many sessions.
  const byMember = {};
  attendance.forEach(a => {
    const m = String(a.member_number || '').trim();
    if (!m || byMember[m]) return;
    byMember[m] = a;
  });
  const uniqueAttendees = Object.keys(byMember).map(k => byMember[k]);

  if (!uniqueAttendees.length) {
    return {
      total_attendees: 0,
      players_added:   0,
      rosters_added:   0,
      message:         'No matching CR_Attendance rows. Pull via Admin → Integrations.',
    };
  }

  const allPlayers = getObjects_('Players');
  const playerByMember = {};
  allPlayers.forEach(p => {
    if (p.club_member_id) playerByMember[String(p.club_member_id).trim()] = p;
  });

  const existingRoster = getObjects_('Rosters').filter(r => r.league_id === league_id);
  const rosteredPlayerIds = {};
  existingRoster.forEach(r => { rosteredPlayerIds[r.player_id] = true; });

  const stamp = nowStamp_();
  const me = activeUserEmail_();
  const newPlayers = [];
  const newRosters = [];

  uniqueAttendees.forEach(a => {
    const m = String(a.member_number).trim();
    let player = playerByMember[m];
    if (!player) {
      const fullName = ((a.first_name || '') + ' ' + (a.last_name || '')).trim();
      player = {
        player_id:      makeId_('player'),
        full_name:      fullName || ('Member ' + m),
        first_name:     a.first_name || '',
        last_name:      a.last_name  || '',
        email:          '',
        phone:          '',
        gender:         '',
        dupr_id:        '',
        club_member_id: m,
        level:          '',
        active:         true,
        notes:          'auto from CR_Attendance',
        created_at:     stamp,
      };
      playerByMember[m] = player;
      newPlayers.push(player);
    }
    if (!rosteredPlayerIds[player.player_id]) {
      newRosters.push({
        roster_id: makeId_('roster'),
        league_id: league_id,
        player_id: player.player_id,
        team_id:   '',
        level:     '',
        status:    'active',
        added_at:  stamp,
        added_by:  me,
      });
      rosteredPlayerIds[player.player_id] = true;
    }
  });

  if (newPlayers.length) appendObjects_('Players', newPlayers);
  if (newRosters.length) appendObjects_('Rosters', newRosters);
  cacheBust_('league:' + league_id + ':full');

  audit_('ladder_roster_sync', 'league', league_id, null, {
    total_attendees: uniqueAttendees.length,
    players_added:   newPlayers.length,
    rosters_added:   newRosters.length,
  });

  return {
    total_attendees: uniqueAttendees.length,
    players_added:   newPlayers.length,
    rosters_added:   newRosters.length,
  };
}

/**
 * Add a manual sub to today's session: creates a Player record (if needed)
 * and returns it. Does NOT add a Rosters row — the sub is session-only.
 *
 * Standings logic skips player_ids not on the league's roster, so games
 * involving this sub are recorded but don't affect their season totals or
 * the league's leaderboard.
 *
 * @param {string} league_id   - for the audit trail; not used for roster
 * @param {string} full_name   - free-text name typed by the operator
 * @returns {{ player_id, full_name }}
 */
function addManualSub_(league_id, full_name) {
  const name = String(full_name || '').trim();
  if (!name) throw new Error('Name required');

  const parts = name.split(/\s+/);
  const stamp = nowStamp_();
  const player = {
    player_id:      makeId_('player'),
    full_name:      name,
    first_name:     parts[0] || '',
    last_name:      parts.length > 1 ? parts.slice(1).join(' ') : '',
    email:          '',
    phone:          '',
    gender:         '',
    dupr_id:        '',
    club_member_id: '',
    level:          '',
    active:         true,
    notes:          'manual sub via Operator (league ' + league_id + ')',
    created_at:     stamp,
  };
  appendObjects_('Players', [player]);
  audit_('manual_sub_add', 'player', player.player_id, null,
    { league_id, full_name: name });
  return { player_id: player.player_id, full_name: name };
}

/**
 * Hard-reset a ladder league's roster: drop ALL existing Rosters rows for the
 * league, then re-run `syncLadderRosterFromAttendance_`. Use when an earlier
 * sync (with the now-fixed name matcher) cross-contaminated the roster with
 * sibling-day attendees. Players themselves are NOT deleted — they may be on
 * other leagues' rosters.
 *
 * @returns {{ rosters_dropped, total_attendees, players_added, rosters_added }}
 */
function resetLadderRosterFromAttendance_(league_id) {
  const league = getLeagueById_(league_id);
  if (!league) throw new Error('League not found: ' + league_id);

  // 1. Drop existing roster rows for this league.
  const all = getObjects_('Rosters');
  const keep = all.filter(r => r.league_id !== league_id);
  const dropped = all.length - keep.length;
  overwriteObjects_('Rosters', keep);
  cacheBust_('league:' + league_id + ':full');
  audit_('league_reset_ladder_roster', 'league', league_id, null, { rosters_dropped: dropped });

  // 2. Re-sync from attendance.
  const sync = syncLadderRosterFromAttendance_(league_id);

  return {
    rosters_dropped: dropped,
    total_attendees: sync.total_attendees,
    players_added:   sync.players_added,
    rosters_added:   sync.rosters_added,
  };
}

/**
 * Add a list of players to a league's roster in one shot.
 *
 * @param {string} league_id
 * @param {Array<Object>} rows — each: { full_name, email, phone?, level?,
 *                                       dupr_id?, club_member_id?, team_name? }
 *                                       For partner format, team_name slots
 *                                       the player into a Team (creating it
 *                                       with this player as P1, or filling P2
 *                                       if it already exists).
 * @returns {{ added, skipped, errors }}
 */
function bulkAddPlayersToLeague_(league_id, rows) {
  if (!league_id) throw new Error('league_id required');
  if (!Array.isArray(rows) || !rows.length) throw new Error('rows required');
  const league = getLeagueById_(league_id);
  if (!league) throw new Error('League not found: ' + league_id);

  let added = 0, skipped = 0;
  const errors = [];
  rows.forEach((row, i) => {
    try {
      if (!row.full_name && !row.email) { skipped++; return; }
      const player = upsertPlayer_({
        full_name:      row.full_name,
        email:          row.email,
        phone:          row.phone,
        level:          row.level,
        dupr_id:        row.dupr_id,
        club_member_id: row.club_member_id,
      });
      let team_id = '';
      if (league.format_type === 'partner' && row.team_name) {
        team_id = slotIntoTeam_(league_id, row.team_name, player.player_id);
      }
      addToRoster_(league_id, player.player_id, { team_id, level: row.level });
      added++;
    } catch (e) {
      errors.push('row ' + (i + 1) + ' (' + (row.full_name || row.email || '?') + '): ' + (e && e.message || e));
    }
  });
  cacheBust_('league:' + league_id + ':full');
  audit_('roster_bulk_add', 'league', league_id, null, { added, skipped, errors: errors.length });
  return { added, skipped, errors };
}
