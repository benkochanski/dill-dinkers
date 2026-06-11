/**
 * Ladder session orchestration.
 *
 * A "session" = one week of play. Two halves, four rounds each. Each group
 * (4 players) plays a 3-game round-robin per half (rotating partners), so
 * each half has a single bye round per group.
 *
 *   Half 1: groups seeded from current season standings
 *           4 rounds × C courts; each group plays games 1→2→3 across 3 of 4
 *           rounds, byes the other.
 *   Halftime: promote/relegate based on half-1 group standings
 *           Rank 1 up 2, Rank 2 up 1, Rank 3 down 1, Rank 4 down 2
 *           (with boundary rules at G1, G2, G(N-1), GN — see
 *           computePromoteRelegateTarget_ for the formula).
 *   Half 2: new groups, same 4-round structure, each group plays 3 games.
 *
 * Next week starts FRESH from season standings; half 2 results don't carry
 * over the way they would in a between-week ladder.
 *
 * Data:
 *   Session_Groups rows are keyed by (league_id, week_number, half, group_number, player_id).
 *   Games rows have an explicit `half` column (1 or 2). Legacy rows with empty
 *   half are treated as half 1 for backward compat.
 *
 * Within a group, the rotation is fixed:
 *   Game 1: slot 1+2 vs slot 3+4
 *   Game 2: slot 1+3 vs slot 2+4
 *   Game 3: slot 1+4 vs slot 2+3
 */

const LADDER_GROUP_SIZE = 4;
const LADDER_GAMES_PER_GROUP = 3;
const LADDER_ROUNDS_PER_HALF = 4;

/**
 * Accept court_numbers as either:
 *   - an array of positive integers  [3, 4, 5, 6]
 *   - a positive integer N           → expanded to [1, 2, …, N]
 *   - 0 / null / undefined           → [] (read-only / no schedule)
 */
function normalizeCourtNumbers_(input) {
  if (input == null || input === 0 || input === '') return [];
  if (Array.isArray(input)) {
    return input.map(Number).filter(n => Number.isFinite(n) && n > 0);
  }
  const n = Number(input);
  if (Number.isFinite(n) && n > 0) {
    return Array.from({ length: Math.round(n) }, (_, i) => i + 1);
  }
  return [];
}

/* ============================================================
 * Helpers
 * ============================================================ */

/** Coerce a half value to 1 or 2. Empty / unknown → 1 (legacy default). */
function normalizeHalf_(h) {
  const n = Number(h);
  return n === 2 ? 2 : 1;
}

function sessionGroupRowMatches_(r, league_id, week_number, half) {
  return r.league_id === league_id &&
         Number(r.week_number) === Number(week_number) &&
         normalizeHalf_(r.half) === Number(half);
}

function gameRowMatchesSession_(g, league_id, week_number, half) {
  return g.league_id === league_id &&
         Number(g.week_number) === Number(week_number) &&
         normalizeHalf_(g.half) === Number(half);
}

/* ============================================================
 * Roster (ranked by season standings)
 * ============================================================ */

/**
 * Roster with each player's current season rank attached. Sorted by rank,
 * with a level/name fallback for unranked players (e.g. week 1).
 */
function getRankedRoster_(league_id) {
  const roster = listRoster_(league_id);
  const standings = computeLadderStandings_(league_id);
  const rankByPid = {};
  const scoreByPid = {};
  const gamesByPid = {};
  standings.forEach(s => {
    rankByPid[s.player_id] = s.rank;
    scoreByPid[s.player_id] = s.score;
    gamesByPid[s.player_id] = s.games_played || 0;
  });

  // Per-player level: CR_Registrations stash a "Level N" string inside
  // user_defined_fields_json. Build pid → level map by joining on
  // Players.club_member_id (preferred) or email.
  const levelByPid = buildPlayerLevelMap_();

  const ranked = roster.map(p => ({
    player_id:    p.player_id,
    full_name:    displayPlayerName_(p),
    email:        p.email || '',
    level:        p.level || levelByPid[p.player_id] || p.roster_level || '',
    season_rank:  rankByPid[p.player_id] || null,
    season_score: scoreByPid[p.player_id] || 0,
    games_played: gamesByPid[p.player_id] || 0,
  }));

  ranked.sort((a, b) => {
    if (a.season_rank && b.season_rank) return a.season_rank - b.season_rank;
    if (a.season_rank) return -1;
    if (b.season_rank) return 1;
    const la = parseInt(String(a.level).replace(/[^0-9]/g, ''), 10) || 0;
    const lb = parseInt(String(b.level).replace(/[^0-9]/g, ''), 10) || 0;
    if (lb !== la) return lb - la;
    return String(a.full_name).localeCompare(String(b.full_name));
  });

  return ranked;
}

/**
 * Scan CR_Registrations for "Level N" strings inside user_defined_fields_json
 * and map them onto Players (via club_member_id or email). Returns
 * { player_id: 'Level 5' }. Empty when CR_Registrations is empty.
 */
function buildPlayerLevelMap_() {
  const out = {};
  let regs = [];
  try { regs = getObjects_('CR_Registrations'); } catch (_) { return out; }
  if (!regs.length) return out;

  const players = getObjects_('Players');
  const byMember = {};
  const byEmail  = {};
  players.forEach(p => {
    if (p.club_member_id) byMember[String(p.club_member_id).trim()] = p.player_id;
    if (p.email)          byEmail[String(p.email).toLowerCase().trim()] = p.player_id;
  });

  regs.forEach(r => {
    const udf = r.user_defined_fields_json || '';
    const m = udf.match(/Level\s*\d+(?:[-–]\d+)?/i);
    if (!m) return;
    const level = m[0];
    const mid = String(r.cr_member_id || '').trim();
    const em  = String(r.email || '').toLowerCase().trim();
    const pid = (mid && byMember[mid]) || (em && byEmail[em]);
    if (pid && !out[pid]) out[pid] = level;
  });
  return out;
}

/* ============================================================
 * Setup / clear / get a session-half
 * ============================================================ */

/**
 * Assign attendees (in their already-ranked order) to groups of 4 and write
 * Session_Groups rows for (league, week, half). Wipes any existing rows for
 * that exact (league, week, half) first.
 *
 * @param {string} league_id
 * @param {number} week_number
 * @param {number} half — 1 or 2
 * @param {string[]} attending_player_ids — flat list, top-4 → group 1, next-4 → group 2, …
 * @param {number[]|number} court_numbers — array of specific court numbers (e.g. [3,4,5,6])
 *        or a plain count N (expanded to [1…N] for backward compat)
 */
function setupSession_(league_id, week_number, half, attending_player_ids, court_numbers) {
  const league = getLeagueById_(league_id);
  if (!league) throw new Error('League not found: ' + league_id);
  if (league.format_type !== 'ladder') throw new Error('Sessions are ladder-only');
  if (!week_number) throw new Error('week_number required');
  half = normalizeHalf_(half);
  if (!Array.isArray(attending_player_ids) || !attending_player_ids.length) {
    throw new Error('attending_player_ids required');
  }
  if (attending_player_ids.length % LADDER_GROUP_SIZE !== 0) {
    throw new Error('Attendance must be a multiple of ' + LADDER_GROUP_SIZE +
      ' (got ' + attending_player_ids.length + '). Adjust attendance and retry.');
  }
  const courtNums = normalizeCourtNumbers_(court_numbers);
  if (!courtNums.length) throw new Error('court_numbers required (non-empty list of court numbers)');

  const num_groups = attending_player_ids.length / LADDER_GROUP_SIZE;
  // 4 rounds × C courts must hold 3 × G games.
  if (LADDER_ROUNDS_PER_HALF * courtNums.length < LADDER_GAMES_PER_GROUP * num_groups) {
    const minCourts = Math.ceil(LADDER_GAMES_PER_GROUP * num_groups / LADDER_ROUNDS_PER_HALF);
    throw new Error('Need at least ' + minCourts + ' courts to fit ' + num_groups +
      ' groups into ' + LADDER_ROUNDS_PER_HALF + ' rounds (have ' + courtNums.length + ').');
  }

  clearSessionGroups_(league_id, week_number, half);

  // If we're (re-)setting up Half 1, any existing Half 2 is now stale —
  // it was built from the OLD Half 1 standings. Clearing prevents the
  // "Half 1 has 3 groups but Half 2 has 2" mismatch when subs are added
  // after Half 2 was already set up.
  if (half === 1) {
    clearSessionGroups_(league_id, week_number, 2);
  }

  // Resolve any ext_<member_number> attendees to REAL players keyed by
  // cr_member_id before storing — so sessions never persist ext_ placeholders.
  // upsertGuestPlayer_ creates a real Players row (cr_member_id) for CR members
  // and is idempotent, so re-setup is safe.
  const _hasExt = crKeyingActive_() &&
    attending_player_ids.some(p => String(p || '').indexOf('ext_') === 0);
  let _nameByMn = {};
  if (_hasExt) {
    try {
      getObjects_('CR_Attendance').forEach(a => {
        const mn = String(a.member_number || '').trim();
        if (mn && !_nameByMn[mn]) _nameByMn[mn] = ((a.first_name || '') + ' ' + (a.last_name || '')).trim();
      });
    } catch (e) { /* no attendance — fine */ }
  }
  const resolvedIds = attending_player_ids.map(pid => {
    const s = String(pid || '').trim();
    if (s.indexOf('ext_') !== 0 || !crKeyingActive_()) return s;
    const mn = s.slice(4);
    try {
      const p = upsertGuestPlayer_({ member_number: mn, full_name: _nameByMn[mn] || ('Member ' + mn) });
      return p.player_id;
    } catch (e) {
      return s;  // resolution failed — keep ext_ rather than lose the attendee
    }
  });

  const stamp = nowStamp_();
  const rows = resolvedIds.map((pid, i) => ({
    session_group_id: makeId_('session'),
    league_id:        league_id,
    week_number:      week_number,
    half:             half,
    group_number:     Math.floor(i / LADDER_GROUP_SIZE) + 1,
    player_id:        pid,
    original_player_id: pid,
    starting_slot:    (i % LADDER_GROUP_SIZE) + 1,
    created_at:       stamp,
  }));
  appendObjects_('Session_Groups', rows);
  // Publish active half + courts so Display tabs (and any other listeners)
  // mirror automatically — also bumps the version stamp.
  setActiveHalf_(league_id, week_number, half, courtNums);

  audit_('session_setup', 'session', league_id + ':w' + week_number + ':h' + half, null,
    { attendees: attending_player_ids.length, groups: num_groups, courts: courtNums.join(',') });

  return getSession_(league_id, week_number, half, courtNums);
}

/**
 * Drop Games rows for (league, week, half) — keeps Session_Groups intact.
 * Use when the operator wants to wipe scores and re-enter them without
 * having to redo attendance / group setup.
 *
 * Returns the count of games removed.
 */
function clearSessionResults_(league_id, week_number, half) {
  const halfNum = (half == null) ? null : normalizeHalf_(half);
  const allGames = getObjects_('Games');
  const before = allGames.length;
  // Never delete completed games — only open/voided rows are cleared.
  const keep = allGames.filter(g => {
    if (g.league_id !== league_id) return true;
    if (Number(g.week_number) !== Number(week_number)) return true;
    if (halfNum != null && normalizeHalf_(g.half) !== halfNum) return true;
    return g.status === 'complete';   // preserve completed scores always
  });
  const removed = before - keep.length;
  if (removed > 0) {
    overwriteObjects_('Games', keep);
    bumpLeagueVersion_(league_id);
    audit_('session_clear_results', 'session',
      league_id + ':w' + week_number + (halfNum == null ? '' : ':h' + halfNum),
      { games_before: before }, { games_removed: removed });
  }
  return removed;
}

/**
 * Drop Session_Groups rows for (league, week, half).
 * If half is null/undefined, drop BOTH halves of that week.
 * Does not touch Games rows.
 */
function clearSessionGroups_(league_id, week_number, half) {
  const halfNum = (half == null) ? null : normalizeHalf_(half);

  // Clear Session_Groups rows.
  const allGroups = getObjects_('Session_Groups');
  const keepGroups = allGroups.filter(r => {
    if (r.league_id !== league_id) return true;
    if (Number(r.week_number) !== Number(week_number)) return true;
    if (halfNum != null && normalizeHalf_(r.half) !== halfNum) return true;
    return false;
  });
  if (keepGroups.length !== allGroups.length) overwriteObjects_('Session_Groups', keepGroups);

  // Delete Games rows for this session half, but NEVER delete completed games.
  // Completed scores are permanent records; only voidGame_() can remove them.
  const allGames = getObjects_('Games');
  const keepGames = allGames.filter(g => {
    if (g.league_id !== league_id) return true;
    if (Number(g.week_number) !== Number(week_number)) return true;
    if (halfNum != null && normalizeHalf_(g.half) !== halfNum) return true;
    return g.status === 'complete';   // preserve completed scores always
  });
  if (keepGames.length !== allGames.length) overwriteObjects_('Games', keepGames);
  bumpLeagueVersion_(league_id);
}

/**
 * Read a session for (league, week, half). Returns:
 *   { exists, league_id, week_number, half, num_courts,
 *     groups: [{ group_number, slots, rotation, standings }],
 *     schedule: [[ {round_number, court_number, group_number, game_in_match, game} ]],
 *     games_played, games_total }
 *
 * If `court_numbers` is 0/null/empty, schedule is empty and the returned games
 * still use the saved game's round/court — useful for read-only views like the
 * halftime preview. Also accepts a plain count N (expanded to [1…N]).
 */
function getSession_(league_id, week_number, half, court_numbers) {
  const league = getLeagueById_(league_id);
  if (!league) throw new Error('League not found');
  half = normalizeHalf_(half);

  const rows = getObjects_('Session_Groups')
    .filter(r => sessionGroupRowMatches_(r, league_id, week_number, half));

  if (!rows.length) {
    return {
      exists: false, league_id, week_number, half,
      groups: [], schedule: [], num_courts: 0,
    };
  }

  const players = getObjects_('Players');
  const playerById = {};
  players.forEach(p => { playerById[p.player_id] = p; });

  // Roster lookup — used to flag players in the session who AREN'T on the
  // league's roster as subs (we append " *" to their name).
  const rosterIds = {};
  getObjects_('Rosters').forEach(r => {
    if (r.league_id === league_id) rosterIds[r.player_id] = true;
  });

  // Build a fallback name map for ext_ IDs (temp external subs not in Players).
  // Key: member_number string → { full_name, level }
  const extByMemberNum = {};
  getObjects_('CR_Attendance').forEach(a => {
    const mn = String(a.member_number || '').trim();
    if (mn && !extByMemberNum[mn]) {
      extByMemberNum[mn] = {
        full_name: (String(a.first_name || '').trim() + ' ' + String(a.last_name || '').trim()).trim(),
        level: '',
      };
    }
  });

  // Flat map for displayPlayerName_ upgrades.
  const extNameByMn = {};
  Object.keys(extByMemberNum).forEach(mn => { extNameByMn[mn] = extByMemberNum[mn].full_name; });
  function resolvePlayer_(pid) {
    if (playerById[pid]) {
      const p = playerById[pid];
      return { player_id: pid, full_name: displayPlayerName_(p, extNameByMn), level: p.level || '' };
    }
    if (String(pid).startsWith('ext_')) {
      const mn = String(pid).slice(4);
      const ext = extByMemberNum[mn];
      if (ext) return { player_id: pid, full_name: ext.full_name || ('Guest ' + mn), level: ext.level || '' };
    }
    return { player_id: pid, full_name: '(unknown)', level: '' };
  }

  // Subs (not on the league's roster) get an asterisk appended so the
  // Display can mark them visually as subs.
  function nameWithSubMark_(pid, name) {
    return rosterIds[pid] ? name : (name + ' *');
  }

  const byGroup = {};
  rows.forEach(r => {
    const g = Number(r.group_number);
    if (!byGroup[g]) byGroup[g] = { group_number: g, slots: {} };
    const slot = Number(r.starting_slot);
    const pl = resolvePlayer_(r.player_id);
    // Match-scope swaps update player_id in place; the new player IS the slot
    // resident and counts for season standings. Only game-scope overrides (set
    // below) flip `swapped` → those games don't count for season standings and
    // the slot displays as "Ghost".
    byGroup[g].slots[slot] = {
      player_id:          r.player_id,
      original_player_id: r.original_player_id || r.player_id,
      swapped:            false,
      full_name:          nameWithSubMark_(r.player_id, displayPlayerName_(pl)),
      starting_slot:      slot,
    };
  });
  const groups = Object.keys(byGroup)
    .map(k => byGroup[k])
    .sort((a, b) => a.group_number - b.group_number);

  // Per-game player overrides (subs who play just one game in the match).
  const overrides = getOverrideMap_(league_id, week_number, half);
  groups.forEach(grp => {
    grp.rotation = computeGroupRotation_(grp.slots);
    applyOverridesToRotation_(grp.rotation, overrides, grp.group_number, resolvePlayer_, nameWithSubMark_);
    // Surface overrides on slot objects too, for the swap-icon UI.
    grp.overrides = (overrides[grp.group_number] || []);
    // Mark any slot with a game-scope override as swapped too — its stats
    // mix in another player, so season standings should exclude its games
    // and the round-standings UI should show "Ghost".
    grp.overrides.forEach(ov => {
      const slot = grp.slots[Number(ov.starting_slot)];
      if (slot) slot.swapped = true;
    });
  });

  const courtNums = normalizeCourtNumbers_(court_numbers);
  const schedule = courtNums.length > 0
    ? computeRoundCourtSchedule_(groups.length, courtNums)
    : [];

  // Cross-reference saved games into schedule cells AND rotation entries.
  const games = listGames_({ league_id }).filter(g =>
    gameRowMatchesSession_(g, league_id, week_number, half) && g.status !== 'voided');
  const gameByKey = {};
  games.forEach(g => {
    const key = Number(g.group_number) + ':' + Number(g.game_in_match);
    gameByKey[key] = g;
  });
  schedule.forEach(round => {
    round.forEach(cell => {
      const key = cell.group_number + ':' + cell.game_in_match;
      cell.game = gameByKey[key] || null;
    });
  });
  // Also attach game data directly to rotation entries so the Display can show
  // scores without needing court numbers (which it doesn't track).
  groups.forEach(grp => {
    grp.rotation.forEach(r => {
      const key = grp.group_number + ':' + r.game_in_match;
      r.game = gameByKey[key] || null;
    });
  });

  // Per-group standings.
  groups.forEach(grp => { grp.standings = computeGroupStandings_(grp, games); });

  return {
    exists: true, league_id, week_number, half,
    groups, schedule,
    court_numbers: courtNums,          // e.g. [3, 4, 5, 6]
    num_courts:    courtNums.length,   // kept for compat / summary text
    games_played: games.filter(g => g.status === 'complete').length,
    games_total: groups.length * LADDER_GAMES_PER_GROUP,
  };
}

/* ============================================================
 * Rotation (within a group of 4)
 * ============================================================ */

/**
 * Given a group's slots {1,2,3,4} → player, return the 3-game rotation:
 *   Game 1: 1+2 vs 3+4
 *   Game 2: 1+3 vs 2+4
 *   Game 3: 1+4 vs 2+3
 */
function computeGroupRotation_(slots) {
  const PAIRS = [
    { game_in_match: 1, t1: [1, 2], t2: [3, 4] },
    { game_in_match: 2, t1: [1, 3], t2: [2, 4] },
    { game_in_match: 3, t1: [1, 4], t2: [2, 3] },
  ];
  return PAIRS.map(p => ({
    game_in_match: p.game_in_match,
    t1_player_1: slots[p.t1[0]] || null,
    t1_player_2: slots[p.t1[1]] || null,
    t2_player_1: slots[p.t2[0]] || null,
    t2_player_2: slots[p.t2[1]] || null,
  }));
}

/* ============================================================
 * Per-game player overrides (Session_Game_Overrides)
 * ============================================================
 *
 * A row swaps one player in/out for a single (group, game_in_match).
 * Returned map shape:
 *   { [group_number]: [{ game_in_match, starting_slot, player_id, original_player_id }] }
 */
function getOverrideMap_(league_id, week_number, half) {
  const out = {};
  let rows = [];
  try { rows = getObjects_('Session_Game_Overrides'); } catch (_) { return out; }
  const h = normalizeHalf_(half);
  rows.forEach(r => {
    if (r.league_id !== league_id) return;
    if (Number(r.week_number) !== Number(week_number)) return;
    if (normalizeHalf_(r.half) !== h) return;
    const g = Number(r.group_number);
    if (!out[g]) out[g] = [];
    out[g].push({
      game_in_match:      Number(r.game_in_match),
      starting_slot:      Number(r.starting_slot),
      player_id:          r.player_id,
      original_player_id: r.original_player_id,
    });
  });
  return out;
}

/**
 * Mutates `rotation` so each rotation entry has the right players after
 * applying per-game slot overrides. `resolvePlayer_` looks up names;
 * `nameWithSubMark_` adds the trailing " *" for non-rostered players.
 */
function applyOverridesToRotation_(rotation, overridesByGroup, group_number, resolvePlayer_, nameWithSubMark_) {
  const list = overridesByGroup[group_number] || [];
  if (!list.length) return;
  // slot positions in each rotation entry, by game_in_match.
  const SLOT_FIELDS = {
    1: { 1: 't1_player_1', 2: 't1_player_2', 3: 't2_player_1', 4: 't2_player_2' },
    2: { 1: 't1_player_1', 3: 't1_player_2', 2: 't2_player_1', 4: 't2_player_2' },
    3: { 1: 't1_player_1', 4: 't1_player_2', 2: 't2_player_1', 3: 't2_player_2' },
  };
  list.forEach(ov => {
    const entry = rotation.find(r => r.game_in_match === ov.game_in_match);
    if (!entry) return;
    const field = (SLOT_FIELDS[ov.game_in_match] || {})[ov.starting_slot];
    if (!field) return;
    const pl = resolvePlayer_(ov.player_id);
    entry[field] = {
      player_id:     ov.player_id,
      full_name:     nameWithSubMark_(ov.player_id, displayPlayerName_(pl)),
      starting_slot: ov.starting_slot,
      override:      true,
    };
  });
}

/**
 * Swap a player in a session. Two scopes:
 *   - 'match' (default): replace the player in Session_Groups for that slot.
 *     Future game saves use the new player. Past completed games keep their
 *     original snapshot. Any per-game overrides for this slot are cleared.
 *   - 'game': add (or update) a Session_Game_Overrides row for one
 *     game_in_match only. Whole-match assignment unchanged.
 *
 * @param {Object} input
 *   league_id, week_number, half, group_number, starting_slot, new_player_id
 *   scope: 'match' | 'game'
 *   game_in_match: required when scope === 'game'
 */
function swapLadderSessionPlayer_(input) {
  const errs = [];
  if (!input.league_id) errs.push('league_id required');
  if (!input.week_number) errs.push('week_number required');
  if (!input.group_number) errs.push('group_number required');
  if (!input.starting_slot) errs.push('starting_slot required');
  if (!input.new_player_id) errs.push('new_player_id required');
  const scope = input.scope === 'game' ? 'game' : 'match';
  if (scope === 'game' && !input.game_in_match) errs.push('game_in_match required when scope=game');
  if (errs.length) throw new Error(errs.join('; '));

  // Resolve an ext_<member_number> swap target to a real cr_member_id player
  // so swaps never persist ext_ placeholders.
  if (crKeyingActive_() && String(input.new_player_id || '').indexOf('ext_') === 0) {
    const mn = String(input.new_player_id).slice(4);
    let nm = '';
    try {
      const att = getObjects_('CR_Attendance').find(a => String(a.member_number || '').trim() === mn);
      if (att) nm = ((att.first_name || '') + ' ' + (att.last_name || '')).trim();
    } catch (e) {}
    try {
      const p = upsertGuestPlayer_({ member_number: mn, full_name: nm || ('Member ' + mn) });
      input.new_player_id = p.player_id;
    } catch (e) { /* keep ext_ if resolution fails */ }
  }

  const half = normalizeHalf_(input.half);
  const group_number = Number(input.group_number);
  const slot = Number(input.starting_slot);

  // Find the Session_Groups row for this slot — needed to know the original
  // player_id, and for 'match' scope we'll rewrite it.
  const all = getObjects_('Session_Groups');
  const sgRow = all.find(r =>
    sessionGroupRowMatches_(r, input.league_id, input.week_number, half) &&
    Number(r.group_number) === group_number &&
    Number(r.starting_slot) === slot);
  if (!sgRow) throw new Error('No Session_Groups slot for group ' + group_number + ' slot ' + slot);
  const original_player_id = sgRow.player_id;

  if (scope === 'match') {
    // Update the slot's player_id in place, and clear any per-game overrides
    // that reference this slot (they're moot now).
    updateWhere_('Session_Groups',
      r => sessionGroupRowMatches_(r, input.league_id, input.week_number, half) &&
           Number(r.group_number) === group_number &&
           Number(r.starting_slot) === slot,
      r => { r.player_id = input.new_player_id; });

    const ovAll = getObjects_('Session_Game_Overrides');
    const keep = ovAll.filter(r => !(
      r.league_id === input.league_id &&
      Number(r.week_number) === Number(input.week_number) &&
      normalizeHalf_(r.half) === half &&
      Number(r.group_number) === group_number &&
      Number(r.starting_slot) === slot
    ));
    if (keep.length !== ovAll.length) overwriteObjects_('Session_Game_Overrides', keep);

    audit_('session_swap_match', 'session_group', sgRow.session_group_id, null, {
      league_id: input.league_id, week_number: input.week_number, half,
      group_number, slot, from: original_player_id, to: input.new_player_id,
    });
    return { scope, group_number, starting_slot: slot, player_id: input.new_player_id };
  }

  // scope === 'game'  → upsert override
  const game_in_match = Number(input.game_in_match);
  const ovAll = getObjects_('Session_Game_Overrides');
  const existing = ovAll.find(r =>
    r.league_id === input.league_id &&
    Number(r.week_number) === Number(input.week_number) &&
    normalizeHalf_(r.half) === half &&
    Number(r.group_number) === group_number &&
    Number(r.game_in_match) === game_in_match &&
    Number(r.starting_slot) === slot);

  if (existing) {
    updateWhere_('Session_Game_Overrides',
      r => r.override_id === existing.override_id,
      r => { r.player_id = input.new_player_id; });
    audit_('session_swap_game', 'override', existing.override_id, null, {
      league_id: input.league_id, week_number: input.week_number, half,
      group_number, slot, game_in_match, to: input.new_player_id,
    });
  } else {
    const override_id = makeId_('override');
    appendObjects_('Session_Game_Overrides', [{
      override_id,
      league_id:          input.league_id,
      week_number:        Number(input.week_number),
      half:               half,
      group_number:       group_number,
      game_in_match:      game_in_match,
      starting_slot:      slot,
      original_player_id: original_player_id,
      player_id:          input.new_player_id,
      created_at:         nowStamp_(),
      created_by:         activeUserEmail_(),
    }]);
    audit_('session_swap_game', 'override', override_id, null, {
      league_id: input.league_id, week_number: input.week_number, half,
      group_number, slot, game_in_match, to: input.new_player_id,
    });
  }
  return { scope, group_number, starting_slot: slot, game_in_match, player_id: input.new_player_id };
}

/* ============================================================
 * Round/court scheduler (always 4 rounds per half)
 * ============================================================ */

/**
 * Greedy round/court scheduler. Always produces exactly 4 rounds per half.
 * Each group plays its 3 games (in rotation order) on 3 of the 4 rounds; the
 * remaining round is the group's bye.
 *
 * Pending plays are processed in "phase" order — all groups' game 1 first,
 * then all game 2, then all game 3 — which spreads each group across rounds
 * rather than burning all of group 1's games before group 2 starts.
 *
 * @param {number}   num_groups   — number of groups this half
 * @param {number[]} court_numbers — actual court numbers to assign (e.g. [3,4,5,6])
 *
 * Caller (setupSession_) validates 4×|courts| ≥ 3×G; if not, the schedule won't fit.
 */
function computeRoundCourtSchedule_(num_groups, court_numbers) {
  if (num_groups < 1 || !court_numbers || !court_numbers.length) return [];
  const numCourts = court_numbers.length;

  // Step 1: pick which (group, game_in_match) pairs play in each round.
  // Phase order (all groups' game 1, then all game 2, then game 3) ensures
  // groups don't burn through all their games before others start.
  const pending = [];
  for (let m = 1; m <= LADDER_GAMES_PER_GROUP; m++) {
    for (let g = 1; g <= num_groups; g++) {
      pending.push({ group_number: g, game_in_match: m });
    }
  }
  const roundPicks = [];
  for (let r = 1; r <= LADDER_ROUNDS_PER_HALF; r++) {
    const playing = [];
    const playedThisRound = {};
    while (playing.length < numCourts) {
      let idx = -1;
      for (let i = 0; i < pending.length; i++) {
        if (!playedThisRound[pending[i].group_number]) { idx = i; break; }
      }
      if (idx === -1) break;
      const item = pending.splice(idx, 1)[0];
      playedThisRound[item.group_number] = true;
      playing.push(item);
    }
    roundPicks.push(playing);
  }

  // Step 2: assign courts with continuity. A group playing in consecutive
  // rounds keeps its court; groups coming off a bye take any court not held
  // by a continuity-preserving group (which corresponds to a court vacated
  // by a group going on bye).
  const rounds = [];
  let prevCourtByGroup = {};
  roundPicks.forEach((playing, ri) => {
    const r = ri + 1;
    const courtAssignments = {};   // court_number → pick
    const usedCourts = {};
    const newcomers = [];

    playing.forEach(item => {
      const prev = prevCourtByGroup[item.group_number];
      if (prev != null && court_numbers.indexOf(prev) !== -1 && !usedCourts[prev]) {
        courtAssignments[prev] = item;
        usedCourts[prev] = true;
      } else {
        newcomers.push(item);
      }
    });
    // Fill newcomers into the remaining (vacated) courts in court_numbers order.
    for (let i = 0; i < court_numbers.length && newcomers.length; i++) {
      const c = court_numbers[i];
      if (usedCourts[c]) continue;
      const item = newcomers.shift();
      courtAssignments[c] = item;
      usedCourts[c] = true;
    }

    // Emit cells in court_numbers order; track new prev map for next round.
    const round = [];
    const newPrev = {};
    court_numbers.forEach(c => {
      const item = courtAssignments[c];
      if (item) {
        round.push({
          round_number:  r,
          court_number:  c,
          group_number:  item.group_number,
          game_in_match: item.game_in_match,
        });
        newPrev[item.group_number] = c;
      }
    });
    prevCourtByGroup = newPrev;
    rounds.push(round);
  });
  // If anything in `pending` is still unfilled, setupSession_'s validation
  // should have caught it. We still return the rounds we did fit so the UI
  // shows what's schedulable.
  return rounds;
}

/* ============================================================
 * Per-group standings (within a half)
 * ============================================================ */

/**
 * Within-group standings: 4 players ranked by wins, tiebreak by points
 * scored, then by starting_slot for stable order.
 *
 * Credit comes from the rotation, NOT the saved t1/t2 player_ids — which
 * makes standings independent of any drift in the Games table (e.g. a
 * pre-half-refactor saved game with stale player_ids still credits the
 * right players this half).
 */
function computeGroupStandings_(group, games) {
  const rotation = computeGroupRotation_(group.slots);
  const cellByGame = {};
  rotation.forEach(r => { cellByGame[r.game_in_match] = r; });

  const playerStats = {};
  Object.keys(group.slots).forEach(slot => {
    const p = group.slots[slot];
    playerStats[p.player_id] = {
      player_id:      p.player_id,
      // Swapped slots (game-scope overrides) display as "Ghost" everywhere
      // grp.standings is rendered — including the halftime-mix UI.
      full_name:      p.swapped ? 'Ghost' : p.full_name,
      starting_slot:  Number(slot),
      games_played:   0,
      wins:           0,
      losses:         0,
      points_for:     0,
      points_against: 0,
    };
  });

  const groupGames = games.filter(g =>
    Number(g.group_number) === group.group_number && g.status === 'complete');

  // For override cells, the cell.player_id is the sub — but the slot's
  // regular resident (now labeled "Ghost" in playerStats) should still get
  // credit for the game. Map slot → resident player_id so we can credit
  // the right row when a cell is an override.
  const residentBySlot = {};
  Object.keys(group.slots).forEach(slot => {
    residentBySlot[Number(slot)] = group.slots[slot].player_id;
  });
  function creditCell_(cellSpot, my, their) {
    if (!cellSpot) return;
    const pid = cellSpot.override
      ? residentBySlot[Number(cellSpot.starting_slot)]
      : cellSpot.player_id;
    if (pid && playerStats[pid]) creditGroupPlayer_(playerStats[pid], my, their);
  }
  groupGames.forEach(g => {
    const cell = cellByGame[Number(g.game_in_match)];
    if (!cell) return;
    const s1 = Number(g.t1_score), s2 = Number(g.t2_score);
    if (Number.isNaN(s1) || Number.isNaN(s2)) return;
    creditCell_(cell.t1_player_1, s1, s2);
    creditCell_(cell.t1_player_2, s1, s2);
    creditCell_(cell.t2_player_1, s2, s1);
    creditCell_(cell.t2_player_2, s2, s1);
  });

  const out = Object.keys(playerStats).map(k => playerStats[k]);
  out.sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.points_for !== a.points_for) return b.points_for - a.points_for;
    return a.starting_slot - b.starting_slot;
  });
  out.forEach((s, i) => { s.rank = i + 1; });
  return out;
}

function creditGroupPlayer_(s, my_score, their_score) {
  s.games_played += 1;
  s.points_for += my_score;
  s.points_against += their_score;
  if (my_score > their_score) s.wins += 1;
  else if (my_score < their_score) s.losses += 1;
}

/* ============================================================
 * Today's (whole-day) standings — aggregated across BOTH halves
 * for a single week. Used by the Display so the "Today's Standings"
 * panel doesn't reset at halftime.
 * ============================================================ */

function computeDayStandings_(league_id, week_number) {
  const v = getLeagueVersion_(league_id);
  return cacheGet_('day:' + league_id + ':' + week_number + ':' + v, 600,
    () => computeDayStandings_uncached_(league_id, week_number));
}

function computeDayStandings_uncached_(league_id, week_number) {
  const games = listGames_({ league_id }).filter(g =>
    Number(g.week_number) === Number(week_number) && g.status === 'complete'
  );

  // Resolver for player names: real Players, plus ext_ subs via CR_Attendance.
  const playerById = {};
  getObjects_('Players').forEach(p => { playerById[p.player_id] = p; });
  const extByMemberNum = {};
  getObjects_('CR_Attendance').forEach(a => {
    const mn = String(a.member_number || '').trim();
    if (mn && !extByMemberNum[mn]) {
      extByMemberNum[mn] = {
        full_name: (String(a.first_name || '').trim() + ' ' + String(a.last_name || '').trim()).trim()
      };
    }
  });
  // Roster IDs — players NOT on this set get a trailing " *" (sub marker).
  const rosterIds = {};
  getObjects_('Rosters').forEach(r => {
    if (r.league_id === league_id) rosterIds[r.player_id] = true;
  });
  const extNameByMn = {};
  Object.keys(extByMemberNum).forEach(mn => { extNameByMn[mn] = extByMemberNum[mn].full_name; });
  function resolveName_(pid) {
    let name;
    if (playerById[pid]) name = displayPlayerName_(playerById[pid], extNameByMn);
    else if (String(pid).startsWith('ext_')) {
      const mn = String(pid).slice(4);
      name = (extByMemberNum[mn] && extByMemberNum[mn].full_name) || ('Guest ' + mn);
    } else {
      name = '(unknown)';
    }
    return rosterIds[pid] ? name : (name + ' *');
  }

  // Index all game-scope overrides for this week. A game with any override
  // is a "Ghost game": none of the 4 actual players get credit for it (in
  // today's OR season standings), and a synthetic "Ghost" row accumulates
  // those stats in today's standings instead.
  const overridesByGameKey = {};  // key → [override rows]
  const gameKey_ = (g) => [
    g.league_id, Number(g.week_number), normalizeHalf_(g.half),
    Number(g.group_number), Number(g.game_in_match)
  ].join('|');
  getObjects_('Session_Game_Overrides').forEach(r => {
    if (r.league_id !== league_id) return;
    if (Number(r.week_number) !== Number(week_number)) return;
    const k = [r.league_id, Number(r.week_number), normalizeHalf_(r.half),
               Number(r.group_number), Number(r.game_in_match)].join('|');
    (overridesByGameKey[k] = overridesByGameKey[k] || []).push(r);
  });

  const stats = {};
  function ensureRow_(pid, displayName) {
    if (!stats[pid]) {
      stats[pid] = {
        player_id: pid, full_name: displayName || resolveName_(pid),
        games_played: 0, wins: 0, losses: 0, points_for: 0, points_against: 0,
      };
    }
    return stats[pid];
  }
  function credit_(pid, my, their) {
    if (!pid) return;
    creditGroupPlayer_(ensureRow_(pid), my, their);
  }
  games.forEach(g => {
    const s1 = Number(g.t1_score), s2 = Number(g.t2_score);
    if (Number.isNaN(s1) || Number.isNaN(s2)) return;

    const overridesForGame = (g.group_number != null && g.game_in_match != null)
      ? (overridesByGameKey[gameKey_(g)] || [])
      : [];

    if (overridesForGame.length === 0) {
      // Normal game — credit all 4 actual players.
      credit_(g.t1_player_1_id, s1, s2);
      credit_(g.t1_player_2_id, s1, s2);
      credit_(g.t2_player_1_id, s2, s1);
      credit_(g.t2_player_2_id, s2, s1);
      return;
    }

    // Ghost game: skip all real-player credits. Credit "Ghost" once per
    // override slot, using the outcome of the team that contained the sub.
    const ghost = ensureRow_('__ghost__', 'Ghost');
    overridesForGame.forEach(ov => {
      const subPid = ov.player_id;
      const onT1 = subPid === g.t1_player_1_id || subPid === g.t1_player_2_id;
      const onT2 = subPid === g.t2_player_1_id || subPid === g.t2_player_2_id;
      if (onT1)      creditGroupPlayer_(ghost, s1, s2);
      else if (onT2) creditGroupPlayer_(ghost, s2, s1);
    });
  });

  const out = Object.values(stats).sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.points_for !== a.points_for) return b.points_for - a.points_for;
    return String(a.full_name).localeCompare(b.full_name);
  });
  out.forEach((p, i) => { p.rank = i + 1; });
  return out;
}

/* ============================================================
 * Promote/relegate (used by halftime mix)
 * ============================================================ */

/**
 * Promote/relegate target group for a single (group, rank) pair.
 *
 *   Rank 1: up 2 (g - 2), clamped to [1, N]
 *   Rank 2: up 1, BUT in G=2 (when N ≥ 3) the player stays in G2 — boundary
 *           rule that keeps G1 from over-filling
 *   Rank 3: down 1, BUT in G=N-1 (when N ≥ 3) the player stays — symmetric
 *           boundary rule for GN
 *   Rank 4: down 2, clamped to [1, N]
 *
 * Verified that every new group ends up at size 4 for any N ≥ 1.
 */
function computePromoteRelegateTarget_(g, rank, N) {
  if (N <= 1) return 1;
  if (rank === 1) return Math.max(1, g - 2);
  if (rank === 2) return (g === 2 && N >= 3) ? 2 : Math.max(1, g - 1);
  if (rank === 3) return (g === N - 1 && N >= 3) ? (N - 1) : Math.min(N, g + 1);
  if (rank === 4) return Math.min(N, g + 2);
  throw new Error('Invalid rank: ' + rank);
}

/**
 * Compute the halftime mix: take half-1 group standings and produce the
 * proposed half-2 groups via promote/relegate.
 *
 * Returns { week_number, num_groups, all_complete, groups: [...] }
 * where each group lists 4 players annotated with from_group / from_rank /
 * new_group, and within-group order is by from_group asc, from_rank asc.
 *
 * Throws if half-1 isn't set up or any source group isn't size 4. Does NOT
 * require all half-1 games to be complete — caller can warn and proceed.
 */
function computeHalftimeMix_(league_id, week_number) {
  const half1 = getSession_(league_id, week_number, 1, 0);
  if (!half1.exists) throw new Error('No 1st Half session for week ' + week_number);
  const N = half1.groups.length;
  if (N < 1) throw new Error('1st Half has no groups');

  const buckets = {};
  for (let g = 1; g <= N; g++) buckets[g] = [];

  half1.groups.forEach(grp => {
    if (grp.standings.length !== LADDER_GROUP_SIZE) {
      throw new Error('Group ' + grp.group_number + ' has ' + grp.standings.length +
        ' players, expected ' + LADDER_GROUP_SIZE);
    }
    grp.standings.forEach((s, i) => {
      const rank = i + 1;
      const target = computePromoteRelegateTarget_(grp.group_number, rank, N);
      buckets[target].push({
        player_id:   s.player_id,
        full_name:   s.full_name,
        from_group:  grp.group_number,
        from_rank:   rank,
        new_group:   target,
        wins:        s.wins,
        points_for:  s.points_for,
      });
    });
  });

  const groups = [];
  for (let g = 1; g <= N; g++) {
    const ps = buckets[g];
    if (ps.length !== LADDER_GROUP_SIZE) {
      throw new Error('Computed half-2 group ' + g + ' has ' + ps.length +
        ' players (expected ' + LADDER_GROUP_SIZE + ').');
    }
    ps.sort((a, b) => a.from_group - b.from_group || a.from_rank - b.from_rank);
    groups.push({ group_number: g, players: ps });
  }

  return {
    week_number:  Number(week_number),
    num_groups:   N,
    all_complete: half1.games_played === half1.games_total,
    groups:       groups,
  };
}

/* ============================================================
 * Save a single session game
 * ============================================================ */

/**
 * Save a ladder session game. Caller passes (league, week, half, group,
 * game_in_match) + scores; we look up the 4 players from Session_Groups for
 * that exact half and compute the partner pairing from the rotation.
 *
 * If a game already exists for (league, week, half, group, game_in_match),
 * update in place and rewrite the player_ids to match the current slot
 * assignments — keeps stored data in sync if the half was reset.
 */
function saveLadderSessionGame_(input) {
  const errs = [];
  if (!input.league_id) errs.push('league_id required');
  if (!input.week_number) errs.push('week_number required');
  if (!input.group_number) errs.push('group_number required');
  if (!input.game_in_match) errs.push('game_in_match required');
  if (errs.length) throw new Error(errs.join('; '));
  const half = normalizeHalf_(input.half);

  const slots = getObjects_('Session_Groups').filter(r =>
    sessionGroupRowMatches_(r, input.league_id, input.week_number, half) &&
    Number(r.group_number) === Number(input.group_number));
  if (slots.length !== LADDER_GROUP_SIZE) {
    throw new Error('Group ' + input.group_number + ' (week ' + input.week_number +
      ', half ' + half + ') has ' + slots.length + ' players, expected ' +
      LADDER_GROUP_SIZE + '. Run setup first.');
  }
  const slotMap = {};
  slots.forEach(s => { slotMap[Number(s.starting_slot)] = { player_id: s.player_id }; });

  // Apply per-game overrides for this (group, game_in_match) before
  // computing the rotation so the right players get snapshotted.
  const game_in_match = Number(input.game_in_match);
  const overrides = getOverrideMap_(input.league_id, input.week_number, half);
  ((overrides[Number(input.group_number)] || [])
    .filter(o => o.game_in_match === game_in_match))
    .forEach(o => {
      if (slotMap[o.starting_slot]) slotMap[o.starting_slot] = { player_id: o.player_id };
    });

  const rotation = computeGroupRotation_(slotMap);
  const cell = rotation.find(r => r.game_in_match === game_in_match);
  if (!cell) throw new Error('Invalid game_in_match: ' + game_in_match);

  const existing = listGames_({ league_id: input.league_id }).find(g =>
    gameRowMatchesSession_(g, input.league_id, input.week_number, half) &&
    Number(g.group_number) === Number(input.group_number) &&
    Number(g.game_in_match) === game_in_match &&
    g.status !== 'voided');

  if (existing) {
    return updateGame_(existing.game_id, {
      t1_score:       input.t1_score,
      t2_score:       input.t2_score,
      round_number:   input.round_number || existing.round_number,
      court_number:   input.court_number || existing.court_number,
      half:           half,
      t1_player_1_id: cell.t1_player_1.player_id,
      t1_player_2_id: cell.t1_player_2.player_id,
      t2_player_1_id: cell.t2_player_1.player_id,
      t2_player_2_id: cell.t2_player_2.player_id,
    });
  }

  return saveGame_({
    league_id:      input.league_id,
    week_number:    input.week_number,
    half:           half,
    round_number:   input.round_number || 0,
    group_number:   input.group_number,
    game_in_match:  game_in_match,
    court_number:   input.court_number || 0,
    play_date:      input.play_date || '',
    t1_player_1_id: cell.t1_player_1.player_id,
    t1_player_2_id: cell.t1_player_2.player_id,
    t2_player_1_id: cell.t2_player_1.player_id,
    t2_player_2_id: cell.t2_player_2.player_id,
    t1_score:       input.t1_score,
    t2_score:       input.t2_score,
  });
}

/* ============================================================
 * Discovery helpers (latest week / half with a session)
 * ============================================================ */

/** Highest week_number in Session_Groups for this league, or null. */
function findLastSessionWeek_(league_id) {
  const rows = getObjects_('Session_Groups').filter(r => r.league_id === league_id);
  if (!rows.length) return null;
  const weeks = rows.map(r => Number(r.week_number)).filter(n => !Number.isNaN(n));
  return weeks.length ? Math.max.apply(null, weeks) : null;
}

/**
 * Most-recent (week, half) that has a Session_Groups.
 * Prefers the half that is IN PROGRESS (has games but not all complete).
 * Falls back to half 1 if both are at 0 games, or half 2 if both are complete.
 * Returns { week, half } or null.
 */
function findLastSessionWeekHalf_(league_id) {
  const week = findLastSessionWeek_(league_id);
  if (!week) return null;
  const rows = getObjects_('Session_Groups').filter(r =>
    r.league_id === league_id && Number(r.week_number) === Number(week));
  const halves = Array.from(new Set(rows.map(r => normalizeHalf_(r.half)))).sort();
  if (halves.length === 1) return { week: week, half: halves[0] };

  // Both halves exist — pick the one in progress (some games played, not all done).
  const games = getObjects_('Games').filter(g =>
    g.league_id === league_id && Number(g.week_number) === Number(week) && g.status !== 'voided');
  const gamesPerHalf = {};
  const completePerHalf = {};
  halves.forEach(h => { gamesPerHalf[h] = 0; completePerHalf[h] = 0; });
  games.forEach(g => {
    const h = normalizeHalf_(g.half);
    if (gamesPerHalf[h] != null) {
      gamesPerHalf[h]++;
      if (g.status === 'complete') completePerHalf[h]++;
    }
  });
  // Prefer the half where games have started but not all are done.
  const inProgress = halves.filter(h => gamesPerHalf[h] > 0 && gamesPerHalf[h] !== completePerHalf[h]);
  if (inProgress.length === 1) return { week: week, half: inProgress[0] };
  if (inProgress.length > 1) return { week: week, half: inProgress[inProgress.length - 1] };

  // None in progress. If the LATER half has Session_Groups but no games yet
  // (just set up via halftime mix), prefer it — it's the active half now.
  const later = halves[halves.length - 1];
  const earlier = halves[0];
  if (gamesPerHalf[later] === 0 && gamesPerHalf[earlier] > 0) {
    return { week: week, half: later };
  }

  // Otherwise prefer the half whose most-recent game activity is newest —
  // this handles the case where Half 1 is fully complete (more rows) but the
  // Operator has already entered some Half 2 scores. Older heuristic was
  // "more games wins," which left Display stuck on a finished Half 1.
  const lastAtPerHalf = {};
  halves.forEach(h => { lastAtPerHalf[h] = ''; });
  games.forEach(g => {
    const h = normalizeHalf_(g.half);
    if (lastAtPerHalf[h] == null) return;
    const t = String(g.updated_at || g.entered_at || '');
    if (t > lastAtPerHalf[h]) lastAtPerHalf[h] = t;
  });
  const byRecency = halves.slice().sort((a, b) => {
    if (lastAtPerHalf[b] !== lastAtPerHalf[a]) return lastAtPerHalf[b] > lastAtPerHalf[a] ? 1 : -1;
    return (gamesPerHalf[b] || 0) - (gamesPerHalf[a] || 0);
  });
  return { week: week, half: byRecency[0] };
}
