/**
 * Schedule generation for partner format.
 *
 * Two algorithms are available:
 *
 *   generatePartnerSchedule_   — legacy circle-method round-robin. Every
 *                                 team plays every round (no byes). Default
 *                                 6 rounds per week.
 *
 *   generatePartnerScheduleV2_ — bye-aware scheduler. Each week has R
 *                                 rounds (default 8), each team plays G
 *                                 games per week (default 6) with R-G byes.
 *                                 For T=8 teams, R=8, G=6 the bye pattern
 *                                 is the unique solution that satisfies:
 *                                   - max 3 consecutive plays
 *                                   - byes spaced ≥4 rounds apart
 *                                   - even spread across rounds
 *                                 Pair counts are kept balanced ±1 across
 *                                 the season via greedy optimal pairing.
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

  // V1 generator path — also materialize so it sees the latest pairings.
  try { materializePairingsToTeams_(league_id); } catch (e) {}
  const teams = listTeams_(league_id);
  if (teams.length < 2) throw new Error('Need at least 2 teams (have ' + teams.length + ')');

  let weeks = getLeagueSchedule_(league_id);
  if (!weeks.length) {
    try {
      populateLeagueScheduleFromAttendance_(league_id);
      weeks = getLeagueSchedule_(league_id);
    } catch (e) { /* fall through */ }
  }
  if (!weeks.length) {
    throw new Error('League has no weeks and no CR_Attendance dates match. ' +
      'Pull attendance first or add weeks manually in the League_Schedule tab.');
  }
  // Partner regular season is capped at 6 weeks (V1 path).
  weeks = weeks.slice(0, 6);

  // Replace any existing schedule rows for this league.
  const existing = getObjects_('Match_Schedule');
  const keep = existing.filter(m => m.league_id !== league_id);
  overwriteObjects_('Match_Schedule', keep);

  const teamIds = teams.map(t => t.team_id);
  const rounds = circleRoundRobin_(teamIds);  // returns array of length N-1, each is array of [tA, tB] pairs

  const userCourts = Array.isArray(opts.court_numbers)
    ? opts.court_numbers.map(Number).filter(n => Number.isFinite(n) && n > 0)
    : [];
  const teamCourtCount = {};
  teamIds.forEach(tid => { teamCourtCount[tid] = {}; });

  const out = [];
  weeks.forEach((wk, wi) => {
    if (wk.skip_week) return;
    const playDate = (opts.play_dates && opts.play_dates[wi]) || wk.play_date || '';

    for (let r = 0; r < rounds_per_week; r++) {
      const round = rounds[(wi * rounds_per_week + r) % rounds.length];
      const matchings = round.filter(p => p[0] && p[1]);
      const gamesThisRound = matchings.length;
      const courts = (userCourts.length >= gamesThisRound)
        ? userCourts.slice()
        : Array.from({ length: gamesThisRound }, (_, i) => i + 1);
      const matchOrder = matchings.map((_, i) => i);
      shuffleInPlace_(matchOrder);
      const used = {};
      const assignments = new Array(matchings.length);
      matchOrder.forEach(mi => {
        const pair = matchings[mi];
        let best = null, bestScore = Infinity;
        const candidates = courts.filter(c => !used[c]);
        shuffleInPlace_(candidates);
        candidates.forEach(c => {
          const s = (teamCourtCount[pair[0]][c] || 0) + (teamCourtCount[pair[1]][c] || 0);
          if (s < bestScore) { bestScore = s; best = c; }
        });
        const c = best != null ? best : candidates[0];
        used[c] = true;
        assignments[mi] = c;
      });
      matchings.forEach((pair, mi) => {
        const c = assignments[mi];
        out.push({
          match_id:     makeId_('match'),
          league_id:    league_id,
          week_number:  wk.week_number,
          game_number:  r + 1,
          court_number: c,
          t1_team_id:   pair[0],
          t2_team_id:   pair[1],
          play_date:    playDate,
          game_id:      '',
        });
        teamCourtCount[pair[0]][c] = (teamCourtCount[pair[0]][c] || 0) + 1;
        teamCourtCount[pair[1]][c] = (teamCourtCount[pair[1]][c] || 0) + 1;
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

/* ====================================================================
   V2 SCHEDULER — bye-aware, balanced
   ==================================================================== */

/**
 * Generate (or replace) the partner schedule with the bye-aware algorithm.
 *
 * Defaults target the canonical 8-team / 8-rounds / 6-games configuration:
 *   - 8 rounds per week
 *   - each team plays 6 games + 2 byes per week
 *   - 36 regular-season games per team (6 weeks × 6 games)
 *   - opponent counts balanced ±1 across the season
 *   - bye placement: max 3 consecutive plays, no two byes within 3 rounds
 *
 * For T=8 teams, the per-week bye assignment uses the unique optimal pattern
 * (proven by direct enumeration of all (b1,b2) ∈ [1..8]² pairs satisfying
 * the spacing constraints + per-round bye-count = 2): two teams take each of
 * the four pair patterns {(1,5),(2,6),(3,7),(4,8)}. The pattern→team
 * assignment is rotated by week index so the same teams don't always sit
 * out the same rounds.
 *
 * For other (T, R, G) combinations the per-round bye count varies — some
 * rounds have ⌊T(R-G)/R⌋ teams on bye and others have ⌈⌉, distributed so the
 * playing count per round is even. Each team still gets exactly R-G byes.
 * The spacing constraints are not enforced in the variable-bye path.
 *
 * @param {string} league_id
 * @param {Object} opts
 *    rounds_per_week — default 8
 *    games_per_team_per_week — default 6
 *    play_dates — optional array of strings (one per non-skipped week)
 * @returns {Object} summary including total_matches, balance, warnings
 */
function generatePartnerScheduleV2_(league_id, opts) {
  opts = opts || {};
  const R = Number(opts.rounds_per_week) || 8;
  const G = Number(opts.games_per_team_per_week) || 6;
  const byesPerTeam = R - G;
  if (byesPerTeam < 0) throw new Error('games_per_team_per_week cannot exceed rounds_per_week');

  const league = getLeagueById_(league_id);
  if (!league) throw new Error('League not found: ' + league_id);
  if (league.format_type !== 'partner') throw new Error('V2 scheduler is partner-only');

  // Make sure Team_Pairings have been turned into Teams + Players rows.
  try { materializePairingsToTeams_(league_id); } catch (e) { /* keep going */ }

  const teams = listTeams_(league_id);
  const T = teams.length;
  if (T < 2) throw new Error('Need at least 2 teams (have ' + T + ')');

  // Distribute total byes (T × byesPerTeam) across the R rounds. Each round's
  // bye count must share parity with T so the playing count is even (and thus
  // pairable). Counts are spread floor/ceil — the caller doesn't need to
  // specify court availability per round; the distribution falls out of the math.
  const byesPerRoundArr = distributeByesAcrossRounds_(T, R, byesPerTeam);
  const byeMin = byesPerRoundArr.length ? Math.min.apply(null, byesPerRoundArr) : 0;
  const byeMax = byesPerRoundArr.length ? Math.max.apply(null, byesPerRoundArr) : 0;

  let weeksAll = getLeagueSchedule_(league_id);
  let autoPopulated = 0;
  if (!weeksAll.length) {
    // Auto-populate weeks from CR_Attendance dates so the operator doesn't
    // have to fill the schedule tab manually before generating.
    try {
      const r = populateLeagueScheduleFromAttendance_(league_id);
      autoPopulated = r.added || 0;
      weeksAll = getLeagueSchedule_(league_id);
    } catch (e) { /* fall through to the explicit error below */ }
  }
  if (!weeksAll.length) {
    throw new Error('League has no weeks and no CR_Attendance dates match. ' +
      'Pull attendance first (Admin → Integrations → Pull ALL attendance) ' +
      'or add weeks manually in the League_Schedule tab.');
  }
  // Partner regular season is capped at 6 weeks. Extra weeks in League_Schedule
  // (e.g. playoffs, makeup days) are left untouched here.
  const PARTNER_MAX_WEEKS = 6;
  const weeks = weeksAll.filter(w => !w.skip_week).slice(0, PARTNER_MAX_WEEKS);

  // Wipe existing schedule for this league.
  const existing = getObjects_('Match_Schedule');
  overwriteObjects_('Match_Schedule', existing.filter(m => m.league_id !== league_id));

  // Stable team-id list (sorted) for deterministic output.
  const teamIds = teams.map(t => t.team_id).slice().sort();

  // Pair-count tracker for season-wide balance.
  const pairKey = (a, b) => a < b ? a + '|' + b : b + '|' + a;
  const pairCount = {};
  for (let i = 0; i < T; i++) {
    for (let j = i + 1; j < T; j++) pairCount[pairKey(teamIds[i], teamIds[j])] = 0;
  }

  const warnings = [];
  if (!(T === 8 && R === 8 && G === 6)) {
    warnings.push(`Bye spacing constraints are only fully enforced for T=8/R=8/G=6. ` +
                  `With T=${T}/R=${R}/G=${G} a fallback bye distribution is used.`);
  }
  if (byeMin !== byeMax) {
    warnings.push(`Per-round bye count varies (${byeMin}–${byeMax}) — pattern: [${byesPerRoundArr.join(',')}].`);
  }

  // Court assignment is intentionally NOT done at generation time. The
  // Operator assigns courts per-week via api_assignCourtsForWeek, so the
  // schedule can adapt to which courts are actually available that night.
  // Match_Schedule rows here have court_number=''.

  const out = [];
  weeks.forEach((wk, wi) => {
    const playDate = (opts.play_dates && opts.play_dates[wi]) || wk.play_date || '';
    const teamByes = assignByePatternsForWeek_(teamIds, wi, R, byesPerTeam, byesPerRoundArr);
    // Track pairs already used this week so the same two teams never play
    // twice in one week. Reset per week.
    const weekPairsUsed = {};

    for (let r = 1; r <= R; r++) {
      const playing = teamIds.filter(tid => !teamByes[tid].has(r));
      if (playing.length % 2 !== 0) {
        throw new Error(`Week ${wk.week_number} round ${r}: ${playing.length} teams playing — must be even.`);
      }
      const matchings = optimalPairing_(playing, pairCount, pairKey, weekPairsUsed);
      matchings.forEach(pair => {
        const k = pairKey(pair[0], pair[1]);
        out.push({
          match_id:     makeId_('match'),
          league_id:    league_id,
          week_number:  wk.week_number,
          game_number:  r,
          court_number: '',  // assigned per-week by the Operator
          t1_team_id:   pair[0],
          t2_team_id:   pair[1],
          play_date:    playDate,
          game_id:      '',
        });
        pairCount[k]++;
        weekPairsUsed[k] = true;
      });
    }
  });

  appendObjects_('Match_Schedule', out);

  // Balance summary
  const counts = Object.keys(pairCount).map(k => pairCount[k]);
  const minC = counts.length ? Math.min.apply(null, counts) : 0;
  const maxC = counts.length ? Math.max.apply(null, counts) : 0;

  audit_('schedule_generate_v2', 'league', league_id, null, {
    rows: out.length, teams: T, weeks: weeks.length,
    balance_min: minC, balance_max: maxC,
    byes_per_round: byesPerRoundArr.join(','),
  });

  return {
    weeks_seen:              weeks.length,
    total_matches:           out.length,
    rounds_per_week:         R,
    games_per_team_per_week: G,
    teams:                   T,
    byes_per_round:          byesPerRoundArr,
    bye_count_min:           byeMin,
    bye_count_max:           byeMax,
    pair_count_min:          minC,
    pair_count_max:          maxC,
    balanced:                (maxC - minC) <= 1,
    warnings:                warnings,
    sample:                  out.slice(0, 5),
  };
}

/**
 * Distribute T × byesPerTeam total byes across R rounds. Each round's bye
 * count must share parity with T (so playing count is even and pairable).
 * Spread floor/ceil round-robin so the per-round counts differ by at most 2,
 * with the heaviest bye counts concentrated in the LAST rounds (so the venue
 * can wind down the night with fewer concurrent games rather than starting
 * heavy).
 *
 * @returns {number[]} length R, sum = T*byesPerTeam, each ∈ [T%2, T] with same parity as T
 */
function distributeByesAcrossRounds_(T, R, byesPerTeam) {
  const totalByes = T * byesPerTeam;
  const parity = T % 2;            // 0 for even T, 1 for odd T
  const minPer = parity;           // smallest legal bye count per round
  if (R < 1) throw new Error('rounds_per_week must be ≥ 1');
  if (totalByes < R * minPer) {
    throw new Error(
      `Cannot distribute byes: total ${totalByes} < min required ${R * minPer} ` +
      `(odd team count requires ≥ 1 bye every round).`
    );
  }
  if (totalByes > R * T) {
    throw new Error(`Cannot distribute byes: total ${totalByes} > max ${R * T}.`);
  }
  const counts = new Array(R).fill(minPer);
  let remaining = totalByes - R * minPer;
  if (remaining % 2 !== 0) {
    throw new Error('Bye distribution math error: remaining ' + remaining + ' not even.');
  }
  // Walk rounds back-to-front so leftover +2 increments land in the later
  // rounds — round R becomes the heaviest bye round, round 1 the lightest.
  let r = R - 1, guard = 0;
  while (remaining >= 2 && guard++ < R * T) {
    if (counts[r] + 2 <= T) {
      counts[r] += 2;
      remaining -= 2;
    }
    r = (r - 1 + R) % R;
  }
  if (remaining !== 0) throw new Error('Bye distribution failed: ' + remaining + ' unallocated.');
  return counts;
}

/**
 * Assign bye rounds to each team for a given week.
 *
 * For T=8 / R=8 / byesPerTeam=2 with uniform 2-byes-per-round, the canonical
 * solution is used:
 *   2 teams use bye pair (1,5)
 *   2 teams use bye pair (2,6)
 *   2 teams use bye pair (3,7)
 *   2 teams use bye pair (4,8)
 * Rotated by weekIdx so different teams sit out different rounds each week.
 *
 * Otherwise: greedy round-robin by round, picking teams that still have bye
 * capacity, with the starting team rotated by weekIdx + round so the same
 * teams don't always land in the heavy rounds. Honors per-round caps from
 * `byesPerRoundArr` (may vary across rounds).
 *
 * @param {Array<number>} byesPerRoundArr — index 0 = round 1, length = R
 * @returns {Object} team_id → Set-like of bye round numbers (1..R)
 */
function assignByePatternsForWeek_(teamIds, weekIdx, R, byesPerTeam, byesPerRoundArr) {
  const T = teamIds.length;
  const out = {};
  // Per-team Set-like object using a backing dict (plain Set sometimes
  // doesn't roundtrip cleanly through other code paths).
  const newSet = () => {
    const data = {};
    return {
      add: r => { data[r] = true; },
      has: r => !!data[r],
    };
  };
  teamIds.forEach(tid => { out[tid] = newSet(); });

  const allTwo = byesPerRoundArr.length === R && byesPerRoundArr.every(b => b === 2);
  if (T === 8 && R === 8 && byesPerTeam === 2 && allTwo) {
    const patterns = [[1, 5], [2, 6], [3, 7], [4, 8]];
    // Rotate which teams get which pattern by weekIdx.
    for (let i = 0; i < 8; i++) {
      const teamId = teamIds[(i + weekIdx) % 8];
      const pattern = patterns[Math.floor(i / 2)];
      pattern.forEach(r => out[teamId].add(r));
    }
    return out;
  }

  // General case: walk rounds in order. For each round pick the teams with
  // the FEWEST byes so far — this prevents low-indexed teams from filling up
  // early and leaving high-indexed teams stranded when a late heavy round
  // can't fit them. Ties broken by a rotation so different teams take the
  // hot seat in different weeks.
  const teamByeCounts = {};
  teamIds.forEach(tid => { teamByeCounts[tid] = 0; });
  const teamIndex = {};
  teamIds.forEach((tid, i) => { teamIndex[tid] = i; });

  // Spacing rule: never give a team a bye-play-bye gap. Equivalent to
  // requiring at least 2 plays between any pair of byes for a team — so a
  // team eligible for a bye in round R must have NO bye in R-1 or R-2.
  // We try strict first; if that leaves a round under-filled, we relax in
  // graduated steps: drop the r-2 constraint (single-play gap allowed),
  // then drop the r-1 constraint (back-to-back byes — last resort).
  function pickEligible(r, strictness) {
    return teamIds.filter(tid => {
      if (teamByeCounts[tid] >= byesPerTeam) return false;
      if (out[tid].has(r)) return false;
      if (strictness >= 1 && out[tid].has(r - 1)) return false;
      if (strictness >= 2 && out[tid].has(r - 2)) return false;
      return true;
    });
  }
  function sortByRotation(list, r) {
    const off = (r + weekIdx) % T;
    list.sort((a, b) => {
      const ca = teamByeCounts[a], cb = teamByeCounts[b];
      if (ca !== cb) return ca - cb;  // teams with fewer byes first
      const ra = ((teamIndex[a] - off) % T + T) % T;
      const rb = ((teamIndex[b] - off) % T + T) % T;
      return ra - rb;
    });
  }

  for (let r = 1; r <= R; r++) {
    const need = byesPerRoundArr[r - 1] || 0;
    if (need <= 0) continue;
    let eligible = pickEligible(r, 2);
    let strictness = 2;
    if (eligible.length < need) {
      eligible = pickEligible(r, 1);  // allow single-play gap
      strictness = 1;
    }
    if (eligible.length < need) {
      eligible = pickEligible(r, 0);  // last-ditch: allow back-to-back byes
      strictness = 0;
    }
    if (eligible.length < need) {
      throw new Error(`Bye assignment failed: round ${r} needs ${need} bye(s) ` +
                      `but only ${eligible.length} team(s) have remaining capacity.`);
    }
    sortByRotation(eligible, r);
    for (let i = 0; i < need; i++) {
      const tid = eligible[i];
      out[tid].add(r);
      teamByeCounts[tid]++;
    }
  }
  // Sanity-check: every team got exactly byesPerTeam byes.
  for (let i = 0; i < T; i++) {
    const tid = teamIds[i];
    if (teamByeCounts[tid] !== byesPerTeam) {
      throw new Error(`Team ${tid} ended with ${teamByeCounts[tid]} byes (expected ${byesPerTeam}).`);
    }
  }
  return out;
}

/**
 * Find a perfect matching of `players` (array of team IDs) into pairs that
 * minimizes the maximum pair count, then by total pair count. Brute-force
 * over all matchings; with ≤8 players that's ≤105 matchings — fast in JS.
 *
 * `forbiddenPairs` (optional): map of pair_key → true. Matchings that include
 * any forbidden pair are skipped. Used to prevent the same two teams from
 * playing twice in one week. If no valid matching exists, falls back to
 * ignoring the constraint (so the schedule still generates).
 */
function optimalPairing_(players, pairCount, pairKey, forbiddenPairs) {
  if (players.length === 0) return [];
  if (players.length % 2 !== 0) throw new Error('Cannot pair odd: ' + players.length);
  forbiddenPairs = forbiddenPairs || {};
  const matchings = enumerateMatchings_(players);

  function pickFrom(filterFn) {
    let best = null, bestMax = Infinity, bestSum = Infinity;
    matchings.forEach(m => {
      if (!filterFn(m)) return;
      let mx = 0, sm = 0;
      m.forEach(pair => {
        const c = pairCount[pairKey(pair[0], pair[1])] || 0;
        if (c > mx) mx = c;
        sm += c;
      });
      if (mx < bestMax || (mx === bestMax && sm < bestSum)) {
        bestMax = mx; bestSum = sm; best = m;
      }
    });
    return best;
  }

  // First pass: respect forbidden pairs.
  const honorForbidden = pickFrom(m =>
    !m.some(pair => forbiddenPairs[pairKey(pair[0], pair[1])]));
  if (honorForbidden) return honorForbidden;
  // Fallback: pick any valid matching even if it uses a forbidden pair.
  return pickFrom(() => true) || [];
}

/**
 * Assign courts to a partner league's matches for a given week.
 * Walks rounds 1..R for the week; for each round picks the best court for
 * each match using a season-wide team-court histogram (computed from already-
 * assigned matches in OTHER weeks, so courts spread evenly over the season).
 *
 * @param {string} league_id
 * @param {number} week_number
 * @param {number[]} court_numbers - the actual court numbers being used this week, e.g. [3,4,5,6,7]
 * @returns {{ assigned, rounds, message }}
 */
function assignCourtsForWeek_(league_id, week_number, court_numbers) {
  const courts = (Array.isArray(court_numbers) ? court_numbers : [])
    .map(Number).filter(n => Number.isFinite(n) && n > 0);
  if (!courts.length) throw new Error('Need at least one court number');
  const all = getObjects_('Match_Schedule').filter(m => m.league_id === league_id);
  const wkMatches = all.filter(m => Number(m.week_number) === Number(week_number));
  if (!wkMatches.length) {
    throw new Error('No matches found for week ' + week_number + '. Generate the schedule first.');
  }
  const otherMatches = all.filter(m => Number(m.week_number) !== Number(week_number));

  // Season-wide team-court histogram, excluding this week (so re-assigning
  // doesn't double-count its own current state).
  const teamCourtCount = {};
  function bump(tid, c) {
    if (!tid || !c) return;
    if (!teamCourtCount[tid]) teamCourtCount[tid] = {};
    teamCourtCount[tid][c] = (teamCourtCount[tid][c] || 0) + 1;
  }
  otherMatches.forEach(m => {
    const c = Number(m.court_number);
    if (!c) return;
    bump(m.t1_team_id, c);
    bump(m.t2_team_id, c);
  });

  // Group this week's matches by round.
  const byRound = {};
  wkMatches.forEach(m => {
    const r = Number(m.game_number);
    if (!byRound[r]) byRound[r] = [];
    byRound[r].push(m);
  });
  const rounds = Object.keys(byRound).map(Number).sort((a, b) => a - b);

  const updates = [];   // { match_id, patch }

  rounds.forEach(r => {
    const matches = byRound[r];
    const gamesThisRound = matches.length;
    if (gamesThisRound > courts.length) {
      throw new Error(`Round ${r} has ${gamesThisRound} games but only ${courts.length} court(s) provided.`);
    }
    const matchOrder = matches.map((_, i) => i);
    shuffleInPlace_(matchOrder);
    const used = {};
    matchOrder.forEach(mi => {
      const m = matches[mi];
      let best = null, bestScore = Infinity;
      const candidates = courts.filter(c => !used[c]);
      shuffleInPlace_(candidates);
      candidates.forEach(c => {
        const s = ((teamCourtCount[m.t1_team_id] && teamCourtCount[m.t1_team_id][c]) || 0) +
                  ((teamCourtCount[m.t2_team_id] && teamCourtCount[m.t2_team_id][c]) || 0);
        if (s < bestScore) { bestScore = s; best = c; }
      });
      const c = best != null ? best : candidates[0];
      used[c] = true;
      updates.push({ match_id: m.match_id, court: c });
      bump(m.t1_team_id, c);
      bump(m.t2_team_id, c);
    });
  });

  // Single batched update on Match_Schedule.
  const courtById = {};
  updates.forEach(u => { courtById[u.match_id] = u.court; });
  updateWhere_('Match_Schedule',
    m => courtById[m.match_id] != null,
    m => { m.court_number = courtById[m.match_id]; });

  bumpLeagueVersion_(league_id);
  audit_('partner_courts_assigned', 'league', league_id, null,
    { week: Number(week_number), courts: courts.join(','), assigned: updates.length });
  return {
    assigned: updates.length,
    rounds:   rounds.length,
    courts:   courts,
    week:     Number(week_number),
  };
}

/** Fisher-Yates in-place shuffle. */
function shuffleInPlace_(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

function enumerateMatchings_(players) {
  if (players.length === 0) return [[]];
  const first = players[0];
  const rest = players.slice(1);
  const result = [];
  for (let i = 0; i < rest.length; i++) {
    const partner = rest[i];
    const remaining = rest.slice(0, i).concat(rest.slice(i + 1));
    enumerateMatchings_(remaining).forEach(sub => {
      result.push([[first, partner]].concat(sub));
    });
  }
  return result;
}

/**
 * Per-team weekly view for the partner Display. For each team:
 *   - team_name + player names
 *   - season standing (rank, W-L, games_back, point_diff, ppg)
 *   - this week's record (wins, losses)
 *   - rounds: array of length R where each round is one of
 *       { kind: 'played', won, opponent_name, opponent_rank, my_score, opp_score, court }
 *       { kind: 'scheduled', opponent_name, opponent_rank, court }
 *       { kind: 'bye' }
 *
 * Sorted by season rank ascending.
 */
function getPartnerWeekView_(league_id, week_number) {
  const league = getLeagueById_(league_id);
  if (!league) throw new Error('League not found: ' + league_id);
  if (league.format_type !== 'partner') throw new Error('Partner-format only.');

  const teams = listTeams_(league_id);
  const players = getObjects_('Players');
  const playerById = {};
  players.forEach(p => { playerById[p.player_id] = p; });

  const standings = computePartnerStandings_(league_id);
  const standingByTeam = {};
  standings.forEach(s => { standingByTeam[s.team_id] = s; });

  const wkn = Number(week_number);
  const matches = getObjects_('Match_Schedule')
    .filter(m => m.league_id === league_id && Number(m.week_number) === wkn);
  const games = listGames_({ league_id })
    .filter(g => Number(g.week_number) === wkn && g.status === 'complete');

  const teamById = {};
  teams.forEach(t => { teamById[t.team_id] = t; });

  // Substitutions for this week — map absent_player_id → sub name so the
  // team card displays the substitute (with a trailing "*") in place of
  // the absent player.
  const subByAbsentId = {};
  getObjects_('Substitutions').forEach(s => {
    if (s.league_id !== league_id) return;
    if (Number(s.week_number) !== wkn) return;
    if (s.absent_player_id) subByAbsentId[s.absent_player_id] = s.substitute_player_name || '';
  });

  const totalRounds = matches.reduce((mx, m) => Math.max(mx, Number(m.game_number)), 0);

  const teamCards = teams.map(t => {
    const rounds = [];
    let wkWins = 0, wkLosses = 0;
    for (let r = 1; r <= totalRounds; r++) {
      const myMatch = matches.find(m =>
        Number(m.game_number) === r &&
        (m.t1_team_id === t.team_id || m.t2_team_id === t.team_id));
      if (!myMatch) { rounds.push({ round: r, kind: 'bye' }); continue; }

      const oppId = myMatch.t1_team_id === t.team_id ? myMatch.t2_team_id : myMatch.t1_team_id;
      const opp = teamById[oppId];
      const oppName = opp ? opp.team_name : '(unknown)';
      const oppRank = standingByTeam[oppId] ? standingByTeam[oppId].rank : null;

      const game = games.find(g =>
        Number(g.round_number) === r &&
        ((g.t1_team_id === myMatch.t1_team_id && g.t2_team_id === myMatch.t2_team_id) ||
         (g.t1_team_id === myMatch.t2_team_id && g.t2_team_id === myMatch.t1_team_id)));

      if (game) {
        const myScore  = (game.t1_team_id === t.team_id) ? Number(game.t1_score) : Number(game.t2_score);
        const oppScore = (game.t1_team_id === t.team_id) ? Number(game.t2_score) : Number(game.t1_score);
        const won = myScore > oppScore;
        if (won) wkWins++; else if (myScore < oppScore) wkLosses++;
        rounds.push({
          round: r, kind: 'played', won,
          opponent_name: oppName, opponent_rank: oppRank,
          my_score: myScore, opp_score: oppScore,
          court: Number(myMatch.court_number),
        });
      } else {
        rounds.push({
          round: r, kind: 'scheduled',
          opponent_name: oppName, opponent_rank: oppRank,
          court: Number(myMatch.court_number),
        });
      }
    }

    const p1 = playerById[t.player_1_id];
    const p2 = playerById[t.player_2_id];
    // If a player is absent and has a sub recorded for the week, display
    // the sub's name with a trailing "*" so spectators can see who's
    // actually playing for the team today.
    const p1Sub = subByAbsentId[t.player_1_id];
    const p2Sub = subByAbsentId[t.player_2_id];
    const p1Name = p1Sub ? (p1Sub + ' *') : (p1 ? p1.full_name : '');
    const p2Name = p2Sub ? (p2Sub + ' *') : (p2 ? p2.full_name : '');
    const s = standingByTeam[t.team_id] || {};
    const ppg = s.games_played ? (s.point_diff / s.games_played) : 0;
    return {
      team_id:   t.team_id,
      team_name: t.team_name,
      player_1_name: p1Name,
      player_2_name: p2Name,
      season: {
        rank:        s.rank        || null,
        wins:        s.wins        || 0,
        losses:      s.losses      || 0,
        games_back:  s.games_back  || 0,
        point_diff:  s.point_diff  || 0,
        ppg:         Math.round(ppg * 10) / 10,
      },
      week: { wins: wkWins, losses: wkLosses },
      rounds: rounds,
    };
  });

  teamCards.sort((a, b) =>
    (a.season.rank || 9999) - (b.season.rank || 9999) ||
    String(a.team_name).localeCompare(String(b.team_name)));

  return {
    league_id, week_number: wkn,
    total_rounds: totalRounds,
    teams: teamCards,
  };
}

/**
 * Pair-count heat map for a partner league. Returns:
 *   { teams: [{team_id, team_name, idx}], counts: [[number, ...], ...] }
 * where counts[i][j] = number of scheduled matches between teams[i] and
 * teams[j] across the whole season. Diagonal is always 0. Symmetric.
 */
function getPartnerPairHeatmap_(league_id) {
  const league = getLeagueById_(league_id);
  if (!league) throw new Error('League not found: ' + league_id);
  if (league.format_type !== 'partner') throw new Error('Partner-format only.');

  const teams = listTeams_(league_id).slice().sort((a, b) =>
    String(a.team_name).localeCompare(String(b.team_name)));
  const idxByTeam = {};
  teams.forEach((t, i) => { idxByTeam[t.team_id] = i; });
  const N = teams.length;
  const counts = [];
  for (let i = 0; i < N; i++) counts.push(new Array(N).fill(0));

  const matches = getObjects_('Match_Schedule').filter(m => m.league_id === league_id);
  matches.forEach(m => {
    const i = idxByTeam[m.t1_team_id];
    const j = idxByTeam[m.t2_team_id];
    if (i == null || j == null) return;
    counts[i][j]++;
    counts[j][i]++;
  });

  let max = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) if (counts[i][j] > max) max = counts[i][j];
  }
  return {
    league_id, league_name: league.name,
    teams: teams.map(t => ({ team_id: t.team_id, team_name: t.team_name })),
    counts,
    max_count: max,
    total_matches: matches.length,
  };
}

/**
 * Per-team season schedule. For each team, an array of week_number → array of
 * round entries: { week, round, court, opponent_team_id, opponent_name,
 *                  is_played, my_score, opp_score, won } | { week, round, kind: 'bye' }
 *
 * Returns: { teams: [{ team_id, team_name, schedule: [...] }] }
 */
function getPartnerTeamSeasonSchedule_(league_id) {
  const league = getLeagueById_(league_id);
  if (!league) throw new Error('League not found: ' + league_id);
  if (league.format_type !== 'partner') throw new Error('Partner-format only.');

  const teams = listTeams_(league_id).slice().sort((a, b) =>
    String(a.team_name).localeCompare(String(b.team_name)));
  const teamById = {};
  teams.forEach(t => { teamById[t.team_id] = t; });

  const matches = getObjects_('Match_Schedule').filter(m => m.league_id === league_id);
  const games = listGames_({ league_id }).filter(g => g.status === 'complete');

  // Discover the rounds-per-week from data so we know how many slots to show.
  let maxRound = 0;
  matches.forEach(m => { const r = Number(m.game_number); if (r > maxRound) maxRound = r; });

  // Group matches by week.
  const byWeek = {};
  matches.forEach(m => {
    const w = Number(m.week_number);
    if (!byWeek[w]) byWeek[w] = [];
    byWeek[w].push(m);
  });
  const weeks = Object.keys(byWeek).map(Number).sort((a, b) => a - b);

  function findGame(m) {
    const w = Number(m.week_number);
    const r = Number(m.game_number);
    return games.find(g =>
      Number(g.week_number) === w &&
      Number(g.round_number) === r &&
      ((g.t1_team_id === m.t1_team_id && g.t2_team_id === m.t2_team_id) ||
       (g.t1_team_id === m.t2_team_id && g.t2_team_id === m.t1_team_id))
    );
  }

  const teamSchedules = teams.map(t => {
    const schedule = [];
    weeks.forEach(w => {
      const wkMatches = byWeek[w] || [];
      const entriesByRound = {};
      wkMatches.forEach(m => {
        if (m.t1_team_id !== t.team_id && m.t2_team_id !== t.team_id) return;
        const oppId = m.t1_team_id === t.team_id ? m.t2_team_id : m.t1_team_id;
        const opp = teamById[oppId];
        const r = Number(m.game_number);
        const game = findGame(m);
        const myScore  = game ? (game.t1_team_id === t.team_id ? Number(game.t1_score) : Number(game.t2_score)) : null;
        const oppScore = game ? (game.t1_team_id === t.team_id ? Number(game.t2_score) : Number(game.t1_score)) : null;
        entriesByRound[r] = {
          week: w, round: r, court: Number(m.court_number),
          opponent_team_id: oppId,
          opponent_name: opp ? opp.team_name : '',
          play_date: m.play_date || '',
          is_played: !!game,
          my_score:  myScore,
          opp_score: oppScore,
          won: game ? myScore > oppScore : null,
        };
      });
      for (let r = 1; r <= maxRound; r++) {
        if (entriesByRound[r]) {
          schedule.push(entriesByRound[r]);
        } else if (wkMatches.length) {
          schedule.push({ week: w, round: r, kind: 'bye' });
        }
      }
    });
    return { team_id: t.team_id, team_name: t.team_name, schedule };
  });

  return {
    league_id, league_name: league.name,
    weeks: weeks,
    rounds_per_week: maxRound,
    teams: teamSchedules,
  };
}

/**
 * Compute the per-team week schedule from generated Match_Schedule rows.
 * Returns: { week_number → team_id → array of length R, where each entry
 * is { round, kind: 'play'|'bye', opponent_team_id?, court_number?, match_id? } }.
 *
 * Useful for the per-team display view.
 */
function buildTeamWeekSchedule_(league_id, week_number) {
  const matches = getObjects_('Match_Schedule')
    .filter(m => m.league_id === league_id &&
                 (week_number == null || String(m.week_number) === String(week_number)));
  if (!matches.length) return {};

  const byWeek = {};
  matches.forEach(m => {
    const wk = String(m.week_number);
    const r  = Number(m.game_number);
    if (!byWeek[wk]) byWeek[wk] = { rounds: {}, teams: {} };
    if (!byWeek[wk].rounds[r]) byWeek[wk].rounds[r] = [];
    byWeek[wk].rounds[r].push(m);
  });

  // For each week, derive each team's per-round entry (play vs bye).
  const teams = listTeams_(league_id);
  const teamIds = teams.map(t => t.team_id);

  Object.keys(byWeek).forEach(wk => {
    const W = byWeek[wk];
    const rounds = Object.keys(W.rounds).map(Number).sort((a,b)=>a-b);
    teamIds.forEach(tid => { W.teams[tid] = []; });
    rounds.forEach(r => {
      const playing = new Set();
      W.rounds[r].forEach(m => {
        playing.add(m.t1_team_id); playing.add(m.t2_team_id);
        // Add a play entry to each side.
        W.teams[m.t1_team_id].push({
          round: r, kind: 'play', opponent_team_id: m.t2_team_id,
          court_number: Number(m.court_number), match_id: m.match_id,
          game_id: m.game_id || '',
        });
        W.teams[m.t2_team_id].push({
          round: r, kind: 'play', opponent_team_id: m.t1_team_id,
          court_number: Number(m.court_number), match_id: m.match_id,
          game_id: m.game_id || '',
        });
      });
      // Anyone not in `playing` has a bye this round.
      teamIds.forEach(tid => {
        if (!playing.has(tid)) {
          W.teams[tid].push({ round: r, kind: 'bye' });
        }
      });
    });
    // Sort each team's rounds.
    teamIds.forEach(tid => W.teams[tid].sort((a,b) => a.round - b.round));
  });

  return byWeek;
}
