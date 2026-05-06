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

/** Returns 1 (team 1 won), 2 (team 2 won), 0 (tie), or '' for incomplete. */
function computeWinner_(s1, s2) {
  if (Number.isNaN(s1) || Number.isNaN(s2)) return '';
  if (s1 == null || s2 == null) return '';
  if (s1 > s2) return 1;
  if (s2 > s1) return 2;
  return 0;
}

function listGames_(filter) {
  const all = getObjects_('Games');
  if (!filter) return all;
  return all.filter(g => Object.keys(filter).every(k => String(g[k]) === String(filter[k])));
}
