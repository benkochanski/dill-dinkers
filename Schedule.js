/**
 * Schedule generation for partner format.
 *
 * Each week, every team plays N opponents (default 6). We use the standard
 * "circle method" round-robin: with K teams there are K-1 unique rounds
 * where every team plays a different opponent. Pick rounds_per_week
 * consecutive rounds from that rotation per week, advancing the offset
 * across weeks so pairings spread evenly across the season.
 *
 * Output goes to the Match_Schedule tab. Operator UI can then pre-fill
 * the next matchup for the current week.
 */

/**
 * Generate (or replace) the schedule for a partner league.
 *
 * @param {string} league_id
 * @param {Object} opts
 *    rounds_per_week — default 6
 *    play_dates — optional array of strings (one per week); if provided,
 *                  must match the number of weeks in League_Schedule
 * @returns {{ weeks_seen, total_matches, sample }}
 */
function generatePartnerSchedule_(league_id, opts) {
  opts = opts || {};
  const rounds_per_week = Number(opts.rounds_per_week) || 6;

  const league = getLeagueById_(league_id);
  if (!league) throw new Error('League not found: ' + league_id);
  if (league.format_type !== 'partner') throw new Error('Schedule generator is partner-only');

  const teams = listTeams_(league_id);
  if (teams.length < 2) throw new Error('Need at least 2 teams (have ' + teams.length + ')');

  const weeks = getLeagueSchedule_(league_id);
  if (!weeks.length) throw new Error('League has no weeks; populate League_Schedule first');

  // Replace any existing schedule rows for this league.
  const existing = getObjects_('Match_Schedule');
  const keep = existing.filter(m => m.league_id !== league_id);
  overwriteObjects_('Match_Schedule', keep);

  const teamIds = teams.map(t => t.team_id);
  const rounds = circleRoundRobin_(teamIds);  // returns array of length N-1, each is array of [tA, tB] pairs

  const out = [];
  weeks.forEach((wk, wi) => {
    if (wk.skip_week) return;
    const playDate = (opts.play_dates && opts.play_dates[wi]) || wk.play_date || '';

    for (let r = 0; r < rounds_per_week; r++) {
      const round = rounds[(wi * rounds_per_week + r) % rounds.length];
      round.forEach((pair, pairIdx) => {
        if (!pair[0] || !pair[1]) return;  // bye
        out.push({
          match_id:     makeId_('match'),
          league_id:    league_id,
          week_number:  wk.week_number,
          game_number:  r + 1,
          court_number: pairIdx + 1,
          t1_team_id:   pair[0],
          t2_team_id:   pair[1],
          play_date:    playDate,
          game_id:      '',  // filled when the game is actually played
        });
      });
    }
  });

  appendObjects_('Match_Schedule', out);
  audit_('schedule_generate', 'league', league_id, null,
    { rows: out.length, teams: teams.length, weeks: weeks.length });

  return {
    weeks_seen:    weeks.length,
    total_matches: out.length,
    sample:        out.slice(0, 5),
  };
}

/**
 * Circle method round-robin. For an even N, returns N-1 rounds where each
 * round is an array of [tA, tB] pairs and every team plays exactly once.
 * For odd N, adds a phantom "bye" team and pairs against null where it
 * would have been.
 */
function circleRoundRobin_(ids) {
  const teams = ids.slice();
  const phantomBye = teams.length % 2 === 1;
  if (phantomBye) teams.push(null);
  const N = teams.length;
  const rounds = [];
  // Fix team[0]; rotate the rest.
  for (let r = 0; r < N - 1; r++) {
    const pairs = [];
    for (let i = 0; i < N / 2; i++) {
      pairs.push([teams[i], teams[N - 1 - i]]);
    }
    rounds.push(pairs);
    // Rotate: keep [0], move [1] to end, shift the rest down.
    teams.splice(1, 0, teams.pop());
  }
  return rounds;
}

/** Fetch the next un-played scheduled match for a league + week. */
function nextScheduledMatch_(league_id, week_number) {
  const all = getObjects_('Match_Schedule')
    .filter(m => m.league_id === league_id &&
                 String(m.week_number) === String(week_number) &&
                 !m.game_id);
  if (!all.length) return null;
  // Sort by game_number then court_number for stable order.
  all.sort((a, b) => Number(a.game_number) - Number(b.game_number) ||
                     Number(a.court_number) - Number(b.court_number));
  return all[0];
}

/** All scheduled matches for a league + week (played and unplayed). */
function listScheduledMatches_(league_id, week_number) {
  return getObjects_('Match_Schedule')
    .filter(m => m.league_id === league_id &&
                 (week_number == null || String(m.week_number) === String(week_number)));
}
