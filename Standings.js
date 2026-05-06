/**
 * Standings recompute. Pure function over Games — never mutates Games,
 * only reads from them.
 *
 * Two formats:
 *   - ladder:  individual player standings (composite Score)
 *   - partner: team standings (W-L + point differential)
 *
 * Public entry: recomputeStandings_(league_id) returns the standings
 * array. Caller can render it directly to a UI; nothing is persisted
 * back to the Sheet (yet — we'll add a Standings_Cache tab if perf
 * dictates).
 */

const POINTS_PER_GAME = 11;

function recomputeStandings_(league_id) {
  const league = getLeagueById_(league_id);
  if (!league) throw new Error('League not found: ' + league_id);
  switch (league.format_type) {
    case 'ladder':  return computeLadderStandings_(league_id);
    case 'partner': return computePartnerStandings_(league_id);
    default:        throw new Error('Unsupported format_type: ' + league.format_type);
  }
}

/* ------------------------------------------------------------------ */
/*  LADDER                                                            */
/* ------------------------------------------------------------------ */

/**
 * Score = 0.6 × W% + 0.4 × P%
 *   W% = (wins + W_bonus) / games
 *   P% = (points_for + P_bonus) / (games × POINTS_PER_GAME)
 *
 * Bonus is computed by computeBonuses_(stats) — currently TODO until
 * the user clarifies the rule. Returns { w_bonus, p_bonus }.
 */
function computeLadderStandings_(league_id) {
  const games = listGames_({ league_id })
    .filter(g => g.status === 'complete');

  const players = getObjects_('Players');
  const playerById = {};
  players.forEach(p => { playerById[p.player_id] = p; });

  const roster = getObjects_('Rosters')
    .filter(r => r.league_id === league_id && r.status === 'active');

  const bonusCfg = getObjects_('Bonus_Config').filter(c => c.league_id === league_id);

  // Build a sub-exclusion set: "substitute_player_id:week_number" pairs.
  // Games played as a sub don't count toward the sub's season standings —
  // they're not a league member and were only filling in.
  const subs = getObjects_('Substitutions').filter(s => s.league_id === league_id);
  const subKeys = new Set();
  subs.forEach(s => {
    if (s.substitute_player_id && s.week_number != null && s.week_number !== '') {
      subKeys.add(s.substitute_player_id + ':' + String(s.week_number));
    }
  });

  // Initialize one row per rostered player so people who haven't played
  // yet still appear (with zeros).
  const stats = {};
  const playerGames = {};  // player_id -> list of games they played in
  roster.forEach(r => {
    stats[r.player_id] = newPlayerStats_(r.player_id, playerById[r.player_id], r.level);
    playerGames[r.player_id] = [];
  });

  // Walk every game and credit each of the 4 players, skipping any player
  // who was acting as a substitute in that week.
  games.forEach(g => {
    const wk = String(g.week_number);
    const t1 = [g.t1_player_1_id, g.t1_player_2_id].filter(Boolean);
    const t2 = [g.t2_player_1_id, g.t2_player_2_id].filter(Boolean);
    const s1 = Number(g.t1_score);
    const s2 = Number(g.t2_score);
    if (Number.isNaN(s1) || Number.isNaN(s2)) return;

    t1.forEach(pid => {
      if (subKeys.has(pid + ':' + wk)) return;  // sub this week — skip
      if (!stats[pid]) return;                   // not on this league's roster — skip
      creditPlayer_(stats[pid], s1, s2, g.week_number);
      playerGames[pid].push(g);
    });
    t2.forEach(pid => {
      if (subKeys.has(pid + ':' + wk)) return;  // sub this week — skip
      if (!stats[pid]) return;                   // not on this league's roster — skip
      creditPlayer_(stats[pid], s2, s1, g.week_number);
      playerGames[pid].push(g);
    });
  });

  const league = getLeagueById_(league_id);

  // Bonuses + percentages + composite score.
  const out = Object.keys(stats).map(pid => {
    const s = stats[pid];
    const bonuses = computeBonuses_(pid, playerGames[pid] || [], league, bonusCfg);
    s.w_bonus = bonuses.w_bonus;
    s.p_bonus = bonuses.p_bonus;
    s.win_pct    = s.games_played ? (s.wins   + s.w_bonus) / s.games_played : 0;
    s.point_pct  = s.games_played ? (s.points + s.p_bonus) / (s.games_played * POINTS_PER_GAME) : 0;
    s.score      = (0.6 * s.win_pct + 0.4 * s.point_pct) * 100;
    s.weeks_played = Object.keys(s.weeks).length;
    return s;
  });

  // Drop any "rostered but never played" rows so we match the reference
  // sheet (only ranked players appear).
  const ranked = out.filter(s => s.games_played > 0);
  ranked.sort((a, b) => b.score - a.score);
  ranked.forEach((s, i) => { s.rank = i + 1; });
  return ranked;
}

function newPlayerStats_(player_id, player, level) {
  return {
    player_id:     player_id,
    full_name:     player ? player.full_name : '(unknown)',
    level:         (player && player.level) || level || '',
    games_played:  0,
    wins:          0,
    losses:        0,
    points:        0,
    points_against: 0,
    weeks:         {},  // set of week_number strings
  };
}

function creditPlayer_(s, my_score, their_score, week_number) {
  s.games_played += 1;
  s.points += my_score;
  s.points_against += their_score;
  if (my_score > their_score) s.wins += 1;
  else if (my_score < their_score) s.losses += 1;
  if (week_number !== '' && week_number != null) s.weeks[String(week_number)] = true;
}

/**
 * Bonus calc — driven by Bonus_Config rows for the league.
 *
 * Rule:
 *   - bonuses kick in once week_number >= league.bonus_starts_week
 *   - W bonus accumulates ONLY on games this player won (one increment per win)
 *   - P bonus accumulates on every qualifying game (win OR loss)
 *   - per-group multiplier comes from Bonus_Config (typically (N-r)*0.03,
 *     so the bottom group is 0)
 *
 * If no Bonus_Config rows exist for the league, returns zero (graceful
 * degrade — standings still compute, just without bonuses).
 *
 * @param {string} player_id — for win lookup against each game
 * @param {Array}  games   subset of games this player appears in
 * @param {Object} league  the league row (for bonus_starts_week)
 * @param {Array}  bonusCfg  the Bonus_Config rows for this league
 */
function computeBonuses_(player_id, games, league, bonusCfg) {
  if (!bonusCfg || !bonusCfg.length) return { w_bonus: 0, p_bonus: 0 };

  const cfgByRank = {};
  bonusCfg.forEach(c => { cfgByRank[String(c.group_rank)] = c; });

  const startsWeek = Number(league && league.bonus_starts_week) || 3;

  let w = 0, p = 0;
  games.forEach(g => {
    if (Number(g.week_number) < startsWeek) return;
    const c = cfgByRank[String(g.group_number)];
    if (!c) return;
    p += Number(c.p_multiplier_per_game) || 0;
    if (playerWonGame_(player_id, g)) {
      w += Number(c.w_multiplier_per_win) || 0;
    }
  });
  return { w_bonus: w, p_bonus: p };
}

function playerWonGame_(player_id, g) {
  const onT1 = g.t1_player_1_id === player_id || g.t1_player_2_id === player_id;
  const onT2 = g.t2_player_1_id === player_id || g.t2_player_2_id === player_id;
  if (onT1 && Number(g.winner) === 1) return true;
  if (onT2 && Number(g.winner) === 2) return true;
  return false;
}

/**
 * Generate Bonus_Config rows for a ladder league using the standard
 *  multiplier = (num_groups - group_rank) * 0.03 rule (so the bottom
 *  group is 0, matching the reference). W and P use the same multiplier.
 *
 *  Idempotent: replaces any existing Bonus_Config rows for this league.
 */
function seedBonusConfigStandard_(league_id, num_groups) {
  const N = Number(num_groups);
  if (!N || N < 1) throw new Error('num_groups must be >= 1');

  // Drop existing config for this league
  const all = getObjects_('Bonus_Config').filter(c => c.league_id !== league_id);
  overwriteObjects_('Bonus_Config', all);

  const rows = [];
  for (let r = 1; r <= N; r++) {
    const m = (N - r) * 0.03;
    rows.push({
      league_id:               league_id,
      group_rank:              r,
      w_multiplier_per_win:    m,
      p_multiplier_per_game:   m,
      notes:                   '(num_groups - group_rank) * 0.03',
    });
  }
  appendObjects_('Bonus_Config', rows);
  audit_('bonus_config_seed', 'league', league_id, null, { num_groups: N });
  return rows;
}

/* ------------------------------------------------------------------ */
/*  PARTNER (Day 3)                                                   */
/* ------------------------------------------------------------------ */

/**
 * Partner format:
 *   - games are team-vs-team (1 game per matchup)
 *   - each team plays multiple opponents per week (typically 6)
 *   - standings: aggregate W-L across all games, tiebreaker = +/- (points
 *     scored - points allowed), then point-pct as final tiebreak
 *   - GB (games behind) = (leader_wins - my_wins + my_losses - leader_losses) / 2
 *
 * Returns one row per team, sorted leader-first.
 */
function computePartnerStandings_(league_id) {
  // Sync Team_Pairings → Teams so standings see the latest pairings.
  try { materializePairingsToTeams_(league_id); } catch (e) {}
  const games = listGames_({ league_id }).filter(g => g.status === 'complete');
  const teams = getObjects_('Teams').filter(t => t.league_id === league_id);
  const players = getObjects_('Players');
  const playerById = {};
  players.forEach(p => { playerById[p.player_id] = p; });

  const stats = {};
  teams.forEach(t => {
    stats[t.team_id] = newTeamStats_(t, playerById);
  });

  games.forEach(g => {
    if (!g.t1_team_id || !g.t2_team_id) return;
    const s1 = Number(g.t1_score), s2 = Number(g.t2_score);
    if (Number.isNaN(s1) || Number.isNaN(s2)) return;
    if (!stats[g.t1_team_id]) stats[g.t1_team_id] = newTeamStats_({ team_id: g.t1_team_id, league_id, team_name: '(unknown)' }, playerById);
    if (!stats[g.t2_team_id]) stats[g.t2_team_id] = newTeamStats_({ team_id: g.t2_team_id, league_id, team_name: '(unknown)' }, playerById);
    creditTeam_(stats[g.t1_team_id], s1, s2, g.week_number);
    creditTeam_(stats[g.t2_team_id], s2, s1, g.week_number);
  });

  const out = Object.keys(stats).map(tid => {
    const s = stats[tid];
    s.point_diff = s.points_for - s.points_against;
    const total_pts = s.points_for + s.points_against;
    s.point_pct = total_pts ? s.points_for / total_pts : 0;
    s.weeks_played = Object.keys(s.weeks).length;
    return s;
  });

  // Sort by wins desc, +/- desc, point_pct desc.
  out.sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.point_diff !== a.point_diff) return b.point_diff - a.point_diff;
    return b.point_pct - a.point_pct;
  });

  if (!out.length) return [];

  const leader = out[0];
  out.forEach((s, i) => {
    s.rank = i + 1;
    s.games_back = ((leader.wins - s.wins) + (s.losses - leader.losses)) / 2;
  });
  return out;
}

function newTeamStats_(team, playerById) {
  const p1 = playerById[team.player_1_id];
  const p2 = playerById[team.player_2_id];
  return {
    team_id:        team.team_id,
    team_name:      team.team_name || '(unnamed)',
    player_1_name:  p1 ? p1.full_name : '',
    player_2_name:  p2 ? p2.full_name : '',
    games_played:   0,
    wins:           0,
    losses:         0,
    points_for:     0,
    points_against: 0,
    weeks:          {},
  };
}

function creditTeam_(s, my_score, their_score, week_number) {
  s.games_played += 1;
  s.points_for += my_score;
  s.points_against += their_score;
  if (my_score > their_score) s.wins += 1;
  else if (my_score < their_score) s.losses += 1;
  if (week_number !== '' && week_number != null) s.weeks[String(week_number)] = true;
}
