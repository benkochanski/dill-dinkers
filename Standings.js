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

  // Initialize one row per rostered player so people who haven't played
  // yet still appear (with zeros).
  const stats = {};
  roster.forEach(r => {
    stats[r.player_id] = newPlayerStats_(r.player_id, playerById[r.player_id], r.level);
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
      creditPlayer_(stats[pid], s1, s2, g.week_number);
    });
    t2.forEach(pid => {
      if (!stats[pid]) stats[pid] = newPlayerStats_(pid, playerById[pid]);
      creditPlayer_(stats[pid], s2, s1, g.week_number);
    });
  });

  // Bonuses + percentages + composite score.
  const out = Object.keys(stats).map(pid => {
    const s = stats[pid];
    const bonuses = computeBonuses_(s);
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
 * Bonus formula. PLACEHOLDER — replace once the user specifies the
 * rule. Reference sheet shows examples like:
 *   16/19 wins, weeks≈4 → W bonus 0.54, P bonus 0.72
 *    9/12 wins, weeks=2 → W bonus 0.24, P bonus 0.36
 *   13/30 wins, all 6 weeks → W bonus 0.00, P bonus 0.00 (anomaly)
 *
 * Current shape: zero. The standings will compute correctly w/o bonuses
 * (just slightly different from reference until we plug in the rule).
 */
function computeBonuses_(stats) {
  return { w_bonus: 0, p_bonus: 0 };
}

/* ------------------------------------------------------------------ */
/*  PARTNER (Day 3)                                                   */
/* ------------------------------------------------------------------ */

function computePartnerStandings_(league_id) {
  // Filled in on Day 3.
  return [];
}
