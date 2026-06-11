/**
 * Game (score) writes.
 *
 * One row per game. Games live in the Games table; everything downstream
 * (standings, display, weekly summaries) is derived from this table by
 * Standings.js and friends.
 *
 * For ladder leagues:  t1_player_1_id, t1_player_2_id, t2_player_1_id, t2_player_2_id
 *                      team_ids stay empty (partners are session-rotating)
 * For partner leagues: t1_team_id, t2_team_id are set; player_ids are
 *                      copied from the team for stat lookups (snapshot at
 *                      game time, so subs are recorded explicitly)
 */

const VALID_GAME_STATUSES = ['open', 'complete', 'voided'];

/**
 * Save (create) a game. Returns the saved object with game_id.
 *
 * @param {Object} g  — fields matching SCHEMA.Games.columns. Validates
 *                       enough to catch most fat-finger errors.
 */
function saveGame_(g) {
  const errs = [];
  if (!g.league_id) errs.push('league_id required');
  if (!g.week_number) errs.push('week_number required');

  // Score sanity. Allow open status with both blank.
  const status = g.status || (g.t1_score !== '' && g.t2_score !== '' ? 'complete' : 'open');
  if (VALID_GAME_STATUSES.indexOf(status) === -1) errs.push('bad status');
  if (status === 'complete') {
    if (g.t1_score === '' || g.t1_score === null || g.t1_score === undefined) errs.push('t1_score required when complete');
    if (g.t2_score === '' || g.t2_score === null || g.t2_score === undefined) errs.push('t2_score required when complete');
  }

  // Team identity. Need either team_ids or all four player_ids.
  const hasTeams = g.t1_team_id && g.t2_team_id;
  const hasPlayers = g.t1_player_1_id && g.t1_player_2_id && g.t2_player_1_id && g.t2_player_2_id;
  if (!hasTeams && !hasPlayers) errs.push('need either team_ids or all four player_ids');

  if (errs.length) throw new Error(errs.join('; '));

  // For partner format, populate player snapshots from the team rows.
  if (hasTeams && !hasPlayers) {
    const teams = getObjects_('Teams');
    const t1 = teams.find(t => t.team_id === g.t1_team_id);
    const t2 = teams.find(t => t.team_id === g.t2_team_id);
    if (!t1) throw new Error('t1_team_id not found: ' + g.t1_team_id);
    if (!t2) throw new Error('t2_team_id not found: ' + g.t2_team_id);
    g.t1_player_1_id = g.t1_player_1_id || t1.player_1_id;
    g.t1_player_2_id = g.t1_player_2_id || t1.player_2_id;
    g.t2_player_1_id = g.t2_player_1_id || t2.player_1_id;
    g.t2_player_2_id = g.t2_player_2_id || t2.player_2_id;
    // If a sub was already paired for this team/week (a Substitutions row),
    // bake it into the fresh snapshot so DUPR + Match Results credit who
    // actually played. Covers pairing a sub BEFORE the score is entered.
    // Best-effort: never let a snapshot lookup block a score save.
    try { applyPairedSubsToGameSnapshot_(g); } catch (e) { /* swallow */ }
  }

  // Upsert: if a non-voided game already exists for this partner-match slot
  // (same league/week/round/court, same team pair in either order), update
  // it in place instead of appending a duplicate row. Player snapshots in
  // the existing row are preserved so prior sub assignments aren't lost.
  if (hasTeams) {
    const existing = listGames_({ league_id: g.league_id }).find(x =>
      x.status !== 'voided' &&
      String(x.week_number)        === String(g.week_number) &&
      String(x.round_number || '') === String(g.round_number || '') &&
      String(x.court_number || '') === String(g.court_number || '') &&
      ((x.t1_team_id === g.t1_team_id && x.t2_team_id === g.t2_team_id) ||
       (x.t1_team_id === g.t2_team_id && x.t2_team_id === g.t1_team_id))
    );
    if (existing) {
      const swap = existing.t1_team_id !== g.t1_team_id;
      return updateGame_(existing.game_id, {
        t1_score: swap ? g.t2_score : g.t1_score,
        t2_score: swap ? g.t1_score : g.t2_score,
      });
    }
  }

  const winner = computeWinner_(Number(g.t1_score), Number(g.t2_score));
  const stamp = nowStamp_();
  const me = activeUserEmail_();
  const game_id = makeId_('game');

  const row = {
    game_id:        game_id,
    league_id:      g.league_id,
    week_number:    g.week_number,
    half:           g.half == null || g.half === '' ? '' : Number(g.half),
    round_number:   g.round_number   || '',
    group_number:   g.group_number   || '',
    match_number:   g.match_number   || '',
    game_in_match:  g.game_in_match  || '',
    court_number:   g.court_number   || '',
    play_date:      g.play_date      || '',
    t1_team_id:     g.t1_team_id     || '',
    t1_player_1_id: g.t1_player_1_id || '',
    t1_player_2_id: g.t1_player_2_id || '',
    t2_team_id:     g.t2_team_id     || '',
    t2_player_1_id: g.t2_player_1_id || '',
    t2_player_2_id: g.t2_player_2_id || '',
    t1_score:       g.t1_score === '' || g.t1_score == null ? '' : Number(g.t1_score),
    t2_score:       g.t2_score === '' || g.t2_score == null ? '' : Number(g.t2_score),
    winner:         winner,
    status:         status,
    entered_by:     me,
    entered_at:     stamp,
    updated_at:     stamp,
    notes:          g.notes || '',
  };

  appendObjects_('Games', [row]);
  bumpLeagueVersion_(g.league_id);
  audit_('game_save', 'game', game_id, null, { score: row.t1_score + '-' + row.t2_score, winner });
  return row;
}

/**
 * Update a game's scores in place. Useful for fixing typos or completing
 * an open game. Recomputes winner.
 */
function updateGame_(game_id, patch) {
  const before = getObjects_('Games').find(g => g.game_id === game_id);
  if (!before) throw new Error('game not found: ' + game_id);

  updateWhere_('Games', g => g.game_id === game_id, g => {
    Object.keys(patch).forEach(k => { if (patch[k] !== undefined) g[k] = patch[k]; });
    if ('t1_score' in patch || 't2_score' in patch) {
      g.winner = computeWinner_(Number(g.t1_score), Number(g.t2_score));
      if (g.t1_score !== '' && g.t2_score !== '') g.status = 'complete';
    }
    g.updated_at = nowStamp_();
  });
  bumpLeagueVersion_(before.league_id);
  audit_('game_update', 'game', game_id, before, patch);
  return getObjects_('Games').find(g => g.game_id === game_id);
}

function voidGame_(game_id, reason) {
  const before = getObjects_('Games').find(g => g.game_id === game_id);
  if (!before) throw new Error('game not found: ' + game_id);
  updateWhere_('Games', g => g.game_id === game_id, g => {
    g.status = 'voided';
    g.notes = (g.notes ? g.notes + ' | ' : '') + 'voided: ' + (reason || '');
    g.updated_at = nowStamp_();
  });
  bumpLeagueVersion_(before.league_id);
  audit_('game_void', 'game', game_id, before.status, 'voided');
}

/**
 * Replace one or more player snapshots on a single partner (team-vs-team) game,
 * WITHOUT touching the teams. This is the per-game substitute: the team still
 * gets the win/loss (partner standings are computed by team_id), but this one
 * game's recorded players — what DUPR export and per-player records read —
 * reflect who actually played. Pass only the slots you want to change.
 *
 * @param {string} game_id
 * @param {Object} players  any of t1_player_1_id, t1_player_2_id,
 *                          t2_player_1_id, t2_player_2_id
 * @return the updated game row
 */
function setPartnerGamePlayers_(game_id, players) {
  const g = getObjects_('Games').find(x => x.game_id === game_id);
  if (!g) throw new Error('game not found: ' + game_id);
  if (!g.t1_team_id || !g.t2_team_id) {
    throw new Error('Per-game player subs apply only to partner (team-vs-team) games.');
  }
  if (g.status === 'voided') throw new Error('Cannot edit a voided game.');

  const SLOTS = ['t1_player_1_id', 't1_player_2_id', 't2_player_1_id', 't2_player_2_id'];
  const known = {};
  getObjects_('Players').forEach(p => { known[p.player_id] = true; });
  const validId = id => !id || known[id] || String(id).startsWith('ext_');

  const patch = {};
  SLOTS.forEach(s => {
    if (players && players[s] !== undefined) {
      const id = String(players[s] || '');
      if (id && !validId(id)) throw new Error('Unknown player for ' + s + ': ' + id);
      patch[s] = id;
    }
  });
  if (!Object.keys(patch).length) return g;

  const before = {};
  SLOTS.forEach(s => { before[s] = g[s]; });
  updateWhere_('Games', x => x.game_id === game_id, x => {
    Object.keys(patch).forEach(k => { x[k] = patch[k]; });
    x.updated_at = nowStamp_();
  });
  bumpLeagueVersion_(g.league_id);
  audit_('partner_game_players_set', 'game', game_id, before, patch);
  return getObjects_('Games').find(x => x.game_id === game_id);
}

/**
 * For a freshly-derived partner game snapshot, apply any subs already paired
 * (Substitutions rows) for this league + week, swapping absent -> sub in the
 * four player slots. Mutates g in place. Counterpart to applying a sub at
 * pairing time: this covers a sub paired BEFORE the game's score was entered,
 * where the snapshot would otherwise capture the absent regular from the roster.
 */
function applyPairedSubsToGameSnapshot_(g) {
  if (!g.t1_team_id || !g.t2_team_id) return;            // partner games only
  if (g.week_number === '' || g.week_number == null) return;
  const map = {};
  getObjects_('Substitutions').forEach(s => {
    if (s.league_id !== g.league_id) return;
    if (String(s.week_number) !== String(g.week_number)) return;
    if (!s.absent_player_id || !s.substitute_player_id) return;
    if (s.absent_player_id === s.substitute_player_id) return;
    map[s.absent_player_id] = s.substitute_player_id;
  });
  if (!Object.keys(map).length) return;
  ['t1_player_1_id', 't1_player_2_id', 't2_player_1_id', 't2_player_2_id'].forEach(k => {
    if (g[k] && map[g[k]]) g[k] = map[g[k]];
  });
}

/** Returns 1 (team 1 won), 2 (team 2 won), 0 (tie), or '' for incomplete. */
function computeWinner_(s1, s2) {
  if (Number.isNaN(s1) || Number.isNaN(s2)) return '';
  if (s1 == null || s2 == null) return '';
  if (s1 > s2) return 1;
  if (s2 > s1) return 2;
  return 0;
}

/**
 * One-off cleanup: scan Games for partner-match duplicates (same league /
 * week / round / court / team pair, in either order) and void all but the
 * most recently updated row in each group.
 *
 * Safe to run repeatedly — voided rows are excluded from future scans and
 * already-deduped slots are no-ops.
 *
 * @param {string} [league_id] — optional filter; otherwise scans every league
 * @return {Object} report: { groups_scanned, duplicates_voided, voided_ids }
 */
function dedupePartnerGames_(league_id) {
  const all = getObjects_('Games').filter(g =>
    g.status !== 'voided' && g.t1_team_id && g.t2_team_id &&
    (!league_id || g.league_id === league_id)
  );
  const groups = {};
  all.forEach(g => {
    const teamKey = [g.t1_team_id, g.t2_team_id].sort().join('|');
    const key = [g.league_id, g.week_number, g.round_number || '', g.court_number || '', teamKey].join('::');
    if (!groups[key]) groups[key] = [];
    groups[key].push(g);
  });
  const voided = [];
  Object.keys(groups).forEach(key => {
    const rows = groups[key];
    if (rows.length < 2) return;
    rows.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    rows.slice(1).forEach(loser => {
      voidGame_(loser.game_id, 'duplicate of ' + rows[0].game_id);
      voided.push(loser.game_id);
    });
  });
  return {
    groups_scanned: Object.keys(groups).length,
    duplicates_voided: voided.length,
    voided_ids: voided,
  };
}

function listGames_(filter) {
  const all = getObjects_('Games');
  if (!filter) return all;
  return all.filter(g => Object.keys(filter).every(k => String(g[k]) === String(filter[k])));
}
