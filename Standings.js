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

  // Initialize one row per rostered player so people who haven't played
  // yet still appear (with zeros).
  const stats = {};
  const playerGames = {};  // player_id -> list of games they played in
  roster.forEach(r => {
    stats[r.player_id] = newPlayerStats_(r.player_id, playerById[r.player_id], r.level);
    playerGames[r.player_id] = [];
  });

  // Walk every game and credit each of the 4 players.
  games.forEach(g => {
    const t1 = [g.t1_player_1_id, g.t1_player_2_id].filter(Boolean);
    const t2 = [g.t2_player_1_id, g.t2_player_2_id].filter(Boolean);
    const s1 = Number(g.t1_score);
    const s2 = Number(g.t2_score);
    if (Number.isNaN(s1) || Number.isNaN(s2)) return;

    t1.forEach(pid => {
      if (!stats[pid]) stats[pid] = newPlayerStats_(pid, playerById[pid]);
      if (!playerGames[pid]) playerGames[pid] = [];
      creditPlayer_(stats[pid], s1, s2, g.week_number);
      playerGames[pid].push(g);
    });
    t2.forEach(pid => {
      if (!stats[pid]) stats[pid] = newPlayerStats_(pid, playerById[pid]);
      if (!playerGames[pid]) playerGames[pid] = [];
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

function computePartnerStandings_(league_id) {
  // Filled in on Day 3.
  return [];
}
