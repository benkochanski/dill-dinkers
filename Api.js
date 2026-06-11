/**
 * Public API surface — these functions are called from HTML pages via
 * google.script.run. Every entry point:
 *   1. Resolves the current user
 *   2. Enforces role
 *   3. Wraps return value in { ok, data } or { ok:false, error }
 *
 * Keep this file thin — the actual logic lives in Leagues.js,
 * Players.js, Games.js, Standings.js. This file is the trust boundary.
 */

function api_listLeagues() {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator']);
    // Cached cross-request for 30s — leagues list is read on every page load.
    return cacheGet_('leagues:list', 30, () => listLeagues_());
  });
}

function api_getLeague(league_id) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator'], league_id);
    return cacheGet_('league:' + league_id + ':full', 30, () => {
      const all = getObjects_('Leagues');
      let league = all.find(l => l.league_id === league_id);
      if (!league) {
        const norm = s => String(s || '').toUpperCase().replace(/O/g, '0').replace(/I/g, '1');
        const target = norm(league_id);
        league = all.find(l => norm(l.league_id) === target);
      }
      if (!league) {
        const sample = all.slice(0, 10).map(l => l.name + ' [' + l.league_id + ']').join(', ');
        throw new Error('League not found: "' + league_id + '". ' +
          'Have ' + all.length + ' leagues, e.g. ' + sample);
      }
      return {
        league: league,
        schedule: getLeagueSchedule_(league.league_id),
        roster: listRoster_(league.league_id),
        teams: league.format_type === 'partner' ? listTeams_(league.league_id) : [],
      };
    });
  });
}

function api_listGames(league_id, weekNumber) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator'], league_id);
    const filter = { league_id: league_id };
    if (weekNumber !== undefined && weekNumber !== '' && weekNumber !== null) {
      filter.week_number = weekNumber;
    }
    return listGames_(filter);
  });
}

function api_saveGame(g) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator'], g && g.league_id);
    return saveGame_(g);
  });
}

function api_updateGame(game_id, patch) {
  return wrap_(() => {
    const user = getCurrentUser_();
    const game = getObjects_('Games').find(x => x.game_id === game_id);
    if (!game) throw new Error('Game not found');
    requireRole_(user, ['admin', 'operator'], game.league_id);
    return updateGame_(game_id, patch);
  });
}

function api_dedupePartnerGames(league_id) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin'], league_id || undefined);
    return dedupePartnerGames_(league_id || null);
  });
}

/**
 * Per-game player substitution for partner games. Rewrites only the named
 * snapshot slots on one game; the teams (and therefore standings) are untouched.
 * @param {string} game_id
 * @param {Object} players  subset of {t1_player_1_id, t1_player_2_id,
 *                          t2_player_1_id, t2_player_2_id}
 */
function api_setPartnerGamePlayers(game_id, players) {
  return wrap_(() => {
    const game = getObjects_('Games').find(x => x.game_id === game_id);
    if (!game) throw new Error('Game not found');
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator'], game.league_id);
    return setPartnerGamePlayers_(game_id, players || {});
  });
}

/** Candidate players for the per-game partner sub picker: roster + recorded subs. */
function api_listPartnerSubCandidates(league_id) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator'], league_id);
    return listPartnerSubCandidates_(league_id);
  });
}

function api_voidGame(game_id, reason) {
  return wrap_(() => {
    const user = getCurrentUser_();
    const game = getObjects_('Games').find(x => x.game_id === game_id);
    if (!game) throw new Error('Game not found');
    requireRole_(user, ['admin', 'operator'], game.league_id);
    voidGame_(game_id, reason);
    return { game_id, voided: true };
  });
}

function api_recomputeStandings(league_id) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator', 'captain'], league_id);
    const standings = recomputeStandings_(league_id);
    // Push to Firebase so subscribed Displays get the new standings without
    // making their own server call. Cheap relative to the recompute itself.
    try {
      publishToFirebase_('leagues/' + league_id + '/standings', {
        rows: standings,
        updated_at: new Date().toISOString(),
      });
    } catch (e) { /* swallow */ }
    // Also push today's standings so the Display's "Today's Standings" panel
    // refreshes after every score. Without this, day_standings only updated
    // on the 60s fallback poll — Firebase fast-path bumps LAST_LEAGUE_VERSION,
    // which prevents the 1.5s version poll from triggering refreshContent().
    // Ladder-only, and only when we can determine the active week.
    try {
      const league = getObjects_('Leagues').find(l => l.league_id === league_id);
      if (league && league.format_type === 'ladder') {
        let week = null;
        const state = getLeagueState_(league_id);
        if (state && state.week) week = Number(state.week);
        if (!week) {
          const live = findLastSessionWeekHalf_(league_id);
          if (live && live.week) week = live.week;
        }
        if (week) {
          const day = computeDayStandings_(league_id, week);
          publishToFirebase_('leagues/' + league_id + '/day_standings', {
            week: week,
            rows: day,
            updated_at: new Date().toISOString(),
          });
        }
      }
    } catch (e) { /* swallow */ }
    return standings;
  });
}

/**
 * Tiny endpoint — just the league's version stamp (a monotonically-increasing
 * integer bumped by any mutator that affects what Display shows). Display
 * polls this every few seconds and only does a full refresh when it changes.
 */
function api_getLeagueVersion(league_id) {
  return wrap_(() => {
    if (!league_id) return 0;
    return getLeagueVersion_(league_id);
  });
}

/**
 * Live state for a league — version stamp + the half the Operator is
 * currently working on. Display polls this and mirrors `week` / `half`
 * automatically (no manual toggle). Returns { version, week, half }.
 */
function api_getLeagueState(league_id) {
  return wrap_(() => {
    if (!league_id) return { version: 0, week: null, half: null };
    const state = getLeagueState_(league_id);
    // The cache can hold a stale half (Operator only republishes on explicit
    // half-tab clicks and score saves; CacheService can evict before TTL).
    // Reconcile with on-disk session activity: if the latest in-progress
    // (week, half) from Session_Groups + Games differs from cache, prefer it.
    try {
      const league = getObjects_('Leagues').find(l => l.league_id === league_id);
      if (league && league.format_type === 'ladder') {
        const live = findLastSessionWeekHalf_(league_id);
        if (live && live.week && live.half) {
          if (state.week !== live.week || state.half !== live.half) {
            state.week = live.week;
            state.half = live.half;
          }
        }
      }
    } catch (e) { /* fall through with cached state */ }
    return state;
  });
}

/**
 * Operator publishes its current half (and courts) so Display can mirror.
 * Tiny CacheService write. Args optional — pass null to leave unchanged.
 */
function api_setActiveHalf(league_id, week, half, courts) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator'], league_id);
    setActiveHalf_(league_id, week, half, courts);
    return getLeagueState_(league_id);
  });
}

/**
 * Operator-triggered "force reload" for every Display tuned to this league.
 * Publishes a tiny command node to Firebase; the Display listener treats a
 * fresh `ts` as a hard reload signal (window.location.reload()).
 *
 * Useful when a TV is stuck on stale content (Firebase hiccup, browser tab
 * paused, manual edit in the Sheet) and the operator wants to nudge it from
 * the entry station without walking over to the display.
 */
function api_refreshDisplays(league_id) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator'], league_id);
    if (!firebaseConfigured_()) {
      throw new Error('Firebase not configured — cannot push refresh.');
    }
    const ts = Date.now();
    publishToFirebase_('leagues/' + league_id + '/command', {
      kind: 'reload',
      ts: ts,
      by: (user && user.email) || '',
    });
    return { ts: ts };
  });
}

function api_createLeague(input) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin']);
    return createLeague_(input);
  });
}

function api_generateSchedule(league_id, opts) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin'], league_id);
    return generatePartnerSchedule_(league_id, opts || {});
  });
}

/**
 * Build League_Schedule rows from the distinct play_dates found in
 * CR_Attendance for this league. Idempotent. Used both as a standalone
 * action and implicitly by the schedule generators when a league has no weeks.
 */
function api_populateLeagueScheduleFromAttendance(league_id) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin'], league_id);
    return populateLeagueScheduleFromAttendance_(league_id);
  });
}

/**
 * Sync League_Schedule weeks from CR_Attendance for ALL active ladder leagues.
 * Safe to call repeatedly — idempotent per league.
 * Returns { synced: [{ league_id, name, added, total }], errors: [...] }
 */
function api_syncAllLeagueWeeksFromAttendance() {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin']);
    return syncAllLeagueWeeks_();
  });
}

/**
 * Server-side bulk sync — also called by the daily time trigger.
 */
function syncAllLeagueWeeks_() {
  const leagues = getObjects_('Leagues').filter(
    l => l.format_type === 'ladder' && l.status === 'active'
  );
  const synced = [];
  const errors = [];
  leagues.forEach(l => {
    try {
      const r = populateLeagueScheduleFromAttendance_(l.league_id);
      synced.push({ league_id: l.league_id, name: l.name, added: r.added, total: r.existing_weeks + r.added });
    } catch (e) {
      errors.push({ league_id: l.league_id, name: l.name, error: String(e.message || e) });
    }
  });
  return { synced, errors };
}


/**
 * Add a single week with a specific play_date to League_Schedule.
 * Idempotent — if that date already exists, returns added:0.
 * Returns { added, week_number, total }.
 */
function api_addLeagueWeek(league_id, play_date) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin'], league_id);
    if (!play_date) throw new Error('play_date is required');
    const dateStr = String(play_date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw new Error('Invalid date: ' + play_date);

    const existing = getObjects_('League_Schedule').filter(s => s.league_id === league_id);
    // Check for duplicate date.
    const alreadyHas = existing.some(s => {
      const d = s.play_date instanceof Date
        ? Utilities.formatDate(s.play_date, CONFIG.TIMEZONE, 'yyyy-MM-dd')
        : String(s.play_date || '').slice(0, 10);
      return d === dateStr;
    });
    if (alreadyHas) return { added: 0, week_number: null, total: existing.length };

    const weekNumber = existing.length + 1;
    const row = {
      schedule_id: makeId_('schedule'),
      league_id:   league_id,
      week_number: weekNumber,
      week_starts: '',
      week_ends:   '',
      play_date:   dateStr,
      skip_week:   false,
      notes:       'manual',
    };
    appendObjects_('League_Schedule', [row]);
    cacheBust_('league:' + league_id + ':full');
    audit_('league_schedule_add_week', 'league', league_id, null, { week_number: weekNumber, play_date: dateStr });
    return { added: 1, week_number: weekNumber, total: existing.length + 1 };
  });
}

/**
 * V2 schedule generation — bye-aware, balanced. Default 8 rounds/week with
 * each team playing 6 + 2 byes.
 */
function api_generateScheduleV2(league_id, opts) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin'], league_id);
    return generatePartnerScheduleV2_(league_id, opts || {});
  });
}

/**
 * Partner Display payload — one card per team for the given week, including
 * season standings, this-week record, and a per-round breakdown (played /
 * scheduled / bye).
 */
function api_getPartnerWeekView(league_id, week_number) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator', 'captain'], league_id);
    return getPartnerWeekView_(league_id, week_number);
  });
}

/**
 * Pair-count heat map for a partner league — T×T matrix of how often each
 * pair of teams plays across the season.
 */
function api_getPartnerPairHeatmap(league_id) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator', 'captain'], league_id);
    return getPartnerPairHeatmap_(league_id);
  });
}

/**
 * Season schedule pivoted by team: every team gets its full week × round
 * sequence with opponent + court + score (where played) or 'bye'.
 */
function api_getPartnerTeamSeasonSchedule(league_id) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator', 'captain'], league_id);
    return getPartnerTeamSeasonSchedule_(league_id);
  });
}

/**
 * Per-team week schedule for a partner league. Returns one entry per team
 * with their 8 rounds for the given week (or all weeks if week_number null).
 */
function api_getTeamWeekSchedule(league_id, week_number) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator', 'captain'], league_id);
    return buildTeamWeekSchedule_(league_id, week_number);
  });
}

/**
 * Returns every Player record joined with their league memberships. Used
 * by the Admin → Players tab for search / lookup. Admin-only.
 */
function api_listAllPlayers() {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin']);
    const players = getObjects_('Players');
    const rosters = getObjects_('Rosters');
    const leagues = getObjects_('Leagues');
    const subs    = getObjects_('Substitutions');
    const leagueById = {};
    leagues.forEach(l => { leagueById[l.league_id] = l; });

    // Group memberships by player_id.
    const leaguesByPid = {};
    rosters.forEach(r => {
      if (!leaguesByPid[r.player_id]) leaguesByPid[r.player_id] = [];
      const l = leagueById[r.league_id];
      if (!l) return;
      leaguesByPid[r.player_id].push({
        league_id:   l.league_id,
        name:        l.name,
        full_name:   l.full_name || l.name,
        format_type: l.format_type,
        status:      l.status,
        season_label: l.season_label || '',
        day_of_week: l.day_of_week || '',
        start_time:  l.start_time || '',
        active:      r.active !== false && String(r.active).toUpperCase() !== 'FALSE',
      });
    });

    // Substitution counts (subbed-in / subbed-out).
    const subStatsByPid = {};
    subs.forEach(s => {
      if (s.absent_player_id) {
        const a = subStatsByPid[s.absent_player_id] || { out: 0, in: 0 };
        a.out += 1;
        subStatsByPid[s.absent_player_id] = a;
      }
      if (s.substitute_player_id) {
        const b = subStatsByPid[s.substitute_player_id] || { out: 0, in: 0 };
        b.in += 1;
        subStatsByPid[s.substitute_player_id] = b;
      }
    });

    return players.map(p => ({
      player_id:      p.player_id,
      full_name:      p.full_name || '',
      email:          p.email || '',
      phone:          p.phone || '',
      level:          p.level || '',
      dupr_id:        p.dupr_id || '',
      club_member_id: p.club_member_id || '',
      gender:         p.gender || '',
      notes:          p.notes || '',
      leagues:        leaguesByPid[p.player_id] || [],
      sub_stats:      subStatsByPid[p.player_id] || { out: 0, in: 0 },
    }));
  });
}

function api_getPlayer(player_id) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator']);
    if (!player_id) throw new Error('player_id required');
    const p = getObjects_('Players').find(x => x.player_id === player_id);
    if (!p) throw new Error('Player not found: ' + player_id);
    return {
      player_id:      p.player_id,
      full_name:      p.full_name || '',
      email:          p.email || '',
      phone:          p.phone || '',
      level:          p.level || '',
      dupr_id:        p.dupr_id || '',
      club_member_id: p.club_member_id || '',
      gender:         p.gender || '',
      notes:          p.notes || '',
    };
  });
}

function api_updatePlayer(player_id, patch) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator']);  // global; no league scope on Players
    if (!player_id) throw new Error('player_id required');
    const before = getObjects_('Players').find(p => p.player_id === player_id);
    if (!before) throw new Error('Player not found: ' + player_id);
    const allowed = ['full_name', 'first_name', 'last_name', 'phone', 'gender',
                     'dupr_id', 'club_member_id', 'level', 'notes', 'email'];
    updateWhere_('Players', p => p.player_id === player_id, p => {
      allowed.forEach(k => {
        if (patch[k] !== undefined) p[k] = patch[k];
      });
    });
    audit_('player_update', 'player', player_id, before, patch);
    return getObjects_('Players').find(p => p.player_id === player_id);
  });
}

function api_listScheduledMatches(league_id, week_number) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator'], league_id);
    return listScheduledMatches_(league_id, week_number);
  });
}

/**
 * Assign actual court numbers to a partner league's matches for one week.
 * Triggered from the Operator when the operator enters today's courts.
 */
function api_assignCourtsForWeek(league_id, week_number, court_numbers) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator'], league_id);
    return assignCourtsForWeek_(league_id, week_number, court_numbers);
  });
}

/**
 * Mark a Match_Schedule row as played by recording the game_id.
 * Called from the Operator after saving a partner game so the admin
 * schedule view can show which matches have been played.
 */
function api_markMatchPlayed(match_id, game_id) {
  return wrap_(() => {
    const user = getCurrentUser_();
    const match = getObjects_('Match_Schedule').find(m => m.match_id === match_id);
    if (!match) throw new Error('Match not found: ' + match_id);
    requireRole_(user, ['admin', 'operator'], match.league_id);
    updateWhere_('Match_Schedule', m => m.match_id === match_id, m => { m.game_id = game_id; });
    return { match_id, game_id };
  });
}

/**
 * Ladder-format roster sync from CR_Attendance. Idempotent.
 */
function api_syncLadderRosterFromAttendance(league_id) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin'], league_id);
    return syncLadderRosterFromAttendance_(league_id);
  });
}

/**
 * Hard reset: wipe the league's roster, then re-sync from attendance. Use
 * when an earlier (buggy) sync left stale roster rows behind.
 */
function api_resetLadderRosterFromAttendance(league_id) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin'], league_id);
    return resetLadderRosterFromAttendance_(league_id);
  });
}

/**
 * Add a manual sub for today's session — creates a Player record but does
 * not add to Rosters. Operator UI pushes the returned player_id into
 * EXTERNAL_SUBS so the sub appears as a checkable attendee.
 */
function api_addManualSub(league_id, full_name, level) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator'], league_id);
    return addManualSub_(league_id, full_name, level);
  });
}

function api_listRoster(league_id) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator', 'captain'], league_id);
    return listRoster_(league_id);
  });
}

function api_listTeams(league_id) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator', 'captain'], league_id);
    return listTeams_(league_id);
  });
}

/* ----- Ladder Session ----- */

function api_getRankedRoster(league_id) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator'], league_id);
    return getRankedRoster_(league_id);
  });
}

function api_setupSession(league_id, week_number, half, attending_player_ids, court_numbers) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator'], league_id);
    const result = setupSession_(league_id, week_number, half, attending_player_ids, court_numbers);
    // Count how many completed games were already present (preserved by the data layer).
    const halfNum = normalizeHalf_(half);
    result.completed_games_preserved = getObjects_('Games').filter(g =>
      g.league_id === league_id &&
      Number(g.week_number) === Number(week_number) &&
      normalizeHalf_(g.half) === halfNum &&
      g.status === 'complete'
    ).length;
    // Push a fresh ladder snapshot so any subscribed Display tabs swap to
    // the new half's groups in one Firebase push, instead of waiting on the
    // 30s state-version safety poll. Without this, the state push fires with
    // the new half number but no session payload, and Display keeps rendering
    // the previous half from its local cache until the fallback poll lands.
    try {
      publishLadderSnapshot_(league_id, week_number, halfNum, court_numbers || []);
    } catch (e) { /* swallow — never break setup because Firebase is flaky */ }
    return result;
  });
}

function api_getSession(league_id, week_number, half, court_numbers) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator'], league_id);
    return getSession_(league_id, week_number, half, court_numbers);
  });
}

function api_clearSession(league_id, week_number, half) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator'], league_id);
    // half null => clears both halves of the week.
    // Completed games are preserved by the data layer regardless.
    clearSessionGroups_(league_id, week_number, half == null ? null : half);
    const halfNum = half == null ? null : normalizeHalf_(half);
    const preserved = getObjects_('Games').filter(g => {
      if (g.league_id !== league_id) return false;
      if (Number(g.week_number) !== Number(week_number)) return false;
      if (halfNum != null && normalizeHalf_(g.half) !== halfNum) return false;
      return g.status === 'complete';
    }).length;
    // Tell subscribed Displays the session is gone so they wipe their local
    // cache and re-render the empty state.
    try {
      publishToFirebase_('leagues/' + league_id + '/session', {
        cleared: true,
        week:    Number(week_number),
        half:    halfNum,
        updated_at: new Date().toISOString(),
      });
      publishToFirebase_('leagues/' + league_id + '/snapshot', null);
    } catch (e) { /* swallow */ }
    return { cleared: true, completed_games_preserved: preserved };
  });
}

/**
 * Soft clear: erase Games rows for (league, week, half) but keep the
 * Session_Groups (attendance + group assignments) intact. Lets the operator
 * re-enter scores without redoing setup.
 */
function api_clearSessionResults(league_id, week_number, half) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator'], league_id);
    const removed = clearSessionResults_(league_id, week_number, half);
    try {
      publishToFirebase_('leagues/' + league_id + '/session', {
        cleared: true,
        week:    Number(week_number),
        half:    half == null ? null : normalizeHalf_(half),
        updated_at: new Date().toISOString(),
      });
      publishToFirebase_('leagues/' + league_id + '/snapshot', null);
    } catch (e) { /* swallow */ }
    return { cleared: true, games_removed: removed };
  });
}

function api_saveLadderSessionGame(input) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator'], input && input.league_id);
    const game = saveLadderSessionGame_(input);
    // Republish active half/week/courts so Display mirrors the half the
    // Operator just saved a score in — covers cases where the cached state
    // was evicted (Apps Script CacheService can drop entries before TTL).
    setActiveHalf_(input.league_id, input.week_number, input.half,
                   input.court_numbers || null);
    const session = getSession_(input.league_id, input.week_number, input.half, input.court_numbers || []);
    // Push the new session to Firebase so subscribed Displays get a live
    // update without polling. Cheap — session is already computed.
    try {
      publishToFirebase_('leagues/' + input.league_id + '/session', {
        week: Number(input.week_number),
        half: Number(input.half),
        session: session,
        updated_at: new Date().toISOString(),
      });
      // Invalidate the stale /snapshot bundle. It's only refreshed at half-setup,
      // not on saves, and the Display applies /snapshot AFTER /session — so a
      // leftover one would clobber the score we just saved (blanked board).
      publishToFirebase_('leagues/' + input.league_id + '/snapshot', null);
    } catch (e) { /* swallow */ }
    // Standings intentionally omitted — the version bump from saveGame_ just
    // invalidated the cache, so recomputing here would block the user-visible
    // "Saved ✓" by a full 7-sheet pass. Operator fires a follow-up
    // api_recomputeStandings in parallel; that path publishes standings to
    // Firebase when done.
    return { game, session };
  });
}

/**
 * Swap a player in a ladder session group, either for the whole match
 * (Session_Groups edit) or for one specific game (Session_Game_Overrides
 * row). See swapLadderSessionPlayer_ for the input shape.
 */
function api_swapLadderSessionPlayer(input) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator'], input && input.league_id);
    const result = swapLadderSessionPlayer_(input);
    const session = getSession_(input.league_id, input.week_number, input.half, input.court_numbers || []);
    // Standings omitted — see note in api_saveLadderSessionGame.
    return { swap: result, session };
  });
}

/**
 * Return a list of candidate replacement players for a session swap.
 * Includes everyone already on the league roster, plus any external subs
 * referenced in current session groups or overrides for this week/half.
 */
function api_listLadderSwapCandidates(league_id, week_number, half) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator'], league_id);

    const roster = listRoster_(league_id);
    const byId = {};
    roster.forEach(p => {
      byId[p.player_id] = {
        player_id: p.player_id,
        full_name: p.full_name,
        level:     p.level || p.roster_level || '',
        on_roster: true,
      };
    });

    // Pull in any external/manual subs already attached to this session.
    const h = normalizeHalf_(half);
    const sgRows = getObjects_('Session_Groups').filter(r =>
      sessionGroupRowMatches_(r, league_id, week_number, h));
    const ovRows = getObjects_('Session_Game_Overrides').filter(r =>
      r.league_id === league_id &&
      Number(r.week_number) === Number(week_number) &&
      normalizeHalf_(r.half) === h);
    const extraIds = {};
    sgRows.forEach(r => { if (r.player_id && !byId[r.player_id]) extraIds[r.player_id] = true; });
    ovRows.forEach(r => { if (r.player_id && !byId[r.player_id]) extraIds[r.player_id] = true; });

    if (Object.keys(extraIds).length) {
      const players = getObjects_('Players');
      const pById = {};
      players.forEach(p => { pById[p.player_id] = p; });

      // Fallback name lookup for ext_<member_number> IDs (CR attendees not
      // materialized into Players yet) — mirrors LadderSession.resolvePlayer_.
      const extByMemberNum = {};
      getObjects_('CR_Attendance').forEach(a => {
        const mn = String(a.member_number || '').trim();
        if (mn && !extByMemberNum[mn]) {
          extByMemberNum[mn] = (String(a.first_name || '').trim() + ' ' +
                                String(a.last_name || '').trim()).trim();
        }
      });

      Object.keys(extraIds).forEach(pid => {
        const p = pById[pid];
        let full_name = p ? displayPlayerName_(p, extByMemberNum) : '';
        let level     = p ? (p.level || '') : '';
        if (!full_name && String(pid).startsWith('ext_')) {
          const mn = String(pid).slice(4);
          full_name = extByMemberNum[mn] || ('Guest ' + mn);
        }
        byId[pid] = {
          player_id: pid,
          full_name: full_name || pid,
          level:     level,
          on_roster: false,
        };
      });
    }

    const list = Object.keys(byId).map(k => byId[k]);
    list.sort((a, b) => String(a.full_name).localeCompare(String(b.full_name)));
    return list;
  });
}

function api_resetLadderGame(game_id, court_numbers) {
  return wrap_(() => {
    const user = getCurrentUser_();
    const game = getObjects_('Games').find(x => x.game_id === game_id);
    if (!game) throw new Error('Game not found');
    requireRole_(user, ['admin', 'operator'], game.league_id);
    voidGame_(game_id, 'operator reset');
    const session = getSession_(game.league_id, game.week_number, game.half, court_numbers || []);
    // Standings omitted — see note in api_saveLadderSessionGame.
    return { session };
  });
}

/**
 * Bundled Display payload. Returns everything the Display needs to render
 * a ladder week/half in a single execution — letting the request-scoped
 * sheet cache (Utils.js) deduplicate reads across what used to be 3 parallel
 * google.script.run calls (each their own cold V8 context).
 *
 *   { session, standings, day_standings }
 */
function api_getDisplayBundleLadder(league_id, week_number, half, court_numbers) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator', 'captain'], league_id);
    return {
      session:        getSession_(league_id, week_number, half, court_numbers),
      standings:      recomputeStandings_(league_id),
      day_standings:  computeDayStandings_(league_id, week_number),
    };
  });
}

/** Partner equivalent: per-team week view + season standings in one call. */
function api_getDisplayBundlePartner(league_id, week_number) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator', 'captain'], league_id);
    return {
      week_view:  getPartnerWeekView_(league_id, week_number),
      standings:  recomputeStandings_(league_id),
    };
  });
}

function api_getDayStandings(league_id, week_number) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator', 'captain'], league_id);
    return computeDayStandings_(league_id, week_number);
  });
}

function api_computeHalftimeMix(league_id, week_number) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator'], league_id);
    return computeHalftimeMix_(league_id, week_number);
  });
}

function api_findLastSessionWeek(league_id) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator', 'captain'], league_id);
    return { week: findLastSessionWeek_(league_id) };
  });
}

function api_findLastSessionWeekHalf(league_id) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator', 'captain'], league_id);
    return findLastSessionWeekHalf_(league_id) || { week: null, half: null };
  });
}

/* ----- Subs ----- */

function api_recordSub(input) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator'], input && input.league_id);
    return recordSubstitution_(input);
  });
}

function api_listSubs(league_id) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator'], league_id);
    return listSubstitutions_({ league_id });
  });
}

/**
 * Unpair a sub-no-show mapping by deleting the Substitutions row.
 */
function api_voidSub(sub_id) {
  return wrap_(() => {
    const user = getCurrentUser_();
    const row = getObjects_('Substitutions').find(s => s.sub_id === sub_id);
    if (!row) throw new Error('Sub not found: ' + sub_id);
    requireRole_(user, ['admin', 'operator'], row.league_id);
    return voidSubstitution_(sub_id);
  });
}

/* ----- CSV Export ----- */

/* ----- Roles + Audit ----- */

function api_listRoles() {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin']);
    return cacheGet_('roles:list', 60, () => listRoles_());
  });
}

function api_addRole(input) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin']);
    return addRole_(input);
  });
}

function api_deactivateRole(email, role, scope_league_id, scope_team_id) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin']);
    const n = deactivateRole_(email, role, scope_league_id, scope_team_id);
    return { deactivated: n };
  });
}

function api_recentAudit(limit) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin']);
    return recentAuditLog_(limit);
  });
}

/* ----- CourtReserve integration ----- */

function api_crGetStatus() {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin']);
    return crGetStatus_();
  });
}

function api_crSetCredentials(input) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin']);
    return crSetCredentials_(input || {});
  });
}

function api_crClearCredentials() {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin']);
    return crClearCredentials_();
  });
}

function api_crPing() {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin']);
    return crPing_();
  });
}

function api_crSyncLog(limit) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin']);
    return crListSyncLog_(limit);
  });
}

function api_crPullToStaging(filters) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin']);
    return pullRegistrationsToStaging_(filters || {});
  });
}

function api_crListStaged(opts) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin']);
    return listStagedRegistrations_(opts || {});
  });
}

function api_crAssignStaged(reg_ids, league_id) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin'], league_id);
    return assignStagedRegistrationsToLeague_(reg_ids, league_id);
  });
}

function api_crGetNoShowsForDate(league_id, date) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator'], league_id);
    return getNoShowsForLeagueDate_(league_id, date || '');
  });
}

function api_crGetEventDatesForLeague(league_id) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator'], league_id);
    return getCREventDatesForLeague_(league_id);
  });
}

/**
 * Distinct session dates derived from CR_Attendance for this league's event
 * name. No registration-assignment step required.
 */
function api_getLadderSessionDates(league_id) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator', 'captain'], league_id);
    return getLadderSessionDatesFromAttendance_(league_id);
  });
}

/**
 * Pull league events from CourtReserve and upsert them into Leagues.
 * After this, Leagues holds one row per CR event with cr_event_id set.
 * Attendance pulls then filter to these event names automatically.
 */
function api_crPullLeagueEvents(filters) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin']);
    return pullLeagueEventsToLeagues_(filters || {});
  });
}

function api_crPullAttendance(filters) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin']);
    return pullAttendanceToStaging_(filters || {});
  });
}

/**
 * Targeted attendance pull for one league × one date. Use on the day of a
 * session to refresh check-in / no-show data without doing an org-wide pull.
 */
function api_crPullAttendanceForLeagueDate(league_id, date) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator'], league_id);
    return pullAttendanceForLeagueDate_(league_id, date);
  });
}

function api_crListAttendance(opts) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin']);
    return listAttendance_(opts || {});
  });
}

function api_crClearAttendance() {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin']);
    return clearAttendance_();
  });
}

/* ----- Members ----- */

function api_crPullMembers(filters) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin']);
    return pullMembersFromCR_(filters || {});
  });
}

function api_crListMembers(opts) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin']);
    return listCRMembers_(opts || {});
  });
}

function api_crClearMembers() {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin']);
    return clearCRMembers_();
  });
}

function api_crSyncLeagues() {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin']);
    return syncLeaguesFromStaging_();
  });
}

/**
 * Diagnostic: snapshot of what the server can read from CR_Registrations
 * AND CR_Attendance. Used to debug "0 rows" issues.
 */
function api_describeCRRegistrationFields() {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin']);

    // CR_Registrations
    const all = getObjects_('CR_Registrations');
    const fields = {};
    let sample = null;
    let withRaw = 0;
    all.forEach(r => {
      if (!r.raw_json) return;
      withRaw++;
      try {
        const o = JSON.parse(r.raw_json);
        if (!sample) sample = o;
        Object.keys(o).forEach(k => { fields[k] = (fields[k] || 0) + 1; });
      } catch (e) {}
    });

    // CR_Attendance — also dump counts + distinct registration_types + a sample row.
    let attendance = [];
    let attendanceErr = '';
    try {
      attendance = getObjects_('CR_Attendance');
    } catch (e) {
      attendanceErr = String(e && e.message || e);
    }
    const attTypes = {};
    const attEvents = {};
    attendance.forEach(a => {
      const t = a.registration_type || '(blank)';
      const e = a.event_name || '(blank)';
      attTypes[t] = (attTypes[t] || 0) + 1;
      attEvents[e] = (attEvents[e] || 0) + 1;
    });
    const attHeaders = (() => {
      try {
        const sh = getSheet_('CR_Attendance');
        return getHeaders_(sh);
      } catch (e) { return ['(error: ' + e.message + ')']; }
    })();

    return {
      registrations: {
        total_rows: all.length,
        rows_with_raw_json: withRaw,
        distinct_field_names: Object.keys(fields).sort()
          .map(k => ({ field: k, count: fields[k] })),
        sample_row: sample,
      },
      attendance: {
        total_rows: attendance.length,
        read_error: attendanceErr,
        sheet_headers: attHeaders,
        registration_types: Object.keys(attTypes).map(t => ({ type: t, count: attTypes[t] }))
          .sort((a, b) => b.count - a.count),
        top_event_names: Object.keys(attEvents)
          .sort((a, b) => attEvents[b] - attEvents[a]).slice(0, 25)
          .map(e => ({ event_name: e, count: attEvents[e] })),
        sample_row: attendance[0] || null,
      },
    };
  });
}

/**
 * Pure-filter view of registrations for a league. No materialization,
 * no Players/Rosters/Teams writes — just a filtered read of CR_Registrations.
 */
function api_listLeaguePlayers(league_id) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator', 'captain'], league_id);
    return listLeaguePlayersFromCR_(league_id);
  });
}

function api_setPlayerDuprOverride(input) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin']);
    return setPlayerDuprOverride_(input || {});
  });
}

/**
 * Pair two players (by CR member_id) into a team for a partner league.
 */
function api_createTeamPairing(input) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin'], input && input.league_id);
    return createTeamPairing_(input || {});
  });
}

function api_renameTeamPairing(pairing_id, team_name) {
  return wrap_(() => {
    const user = getCurrentUser_();
    const p = getObjects_('Team_Pairings').find(x => x.pairing_id === pairing_id);
    if (!p) throw new Error('Pairing not found: ' + pairing_id);
    requireRole_(user, ['admin'], p.league_id);
    return renameTeamPairing_(pairing_id, team_name);
  });
}

function api_deleteTeamPairing(pairing_id) {
  return wrap_(() => {
    const user = getCurrentUser_();
    const p = getObjects_('Team_Pairings').find(x => x.pairing_id === pairing_id);
    if (!p) throw new Error('Pairing not found: ' + pairing_id);
    requireRole_(user, ['admin'], p.league_id);
    return deleteTeamPairing_(pairing_id);
  });
}

function api_setTeamNameOverride(cr_reg_id, team_name) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin']);
    return setTeamNameOverride_(cr_reg_id, team_name);
  });
}

/**
 * Wipe roster + teams for a league and re-match against existing CR
 * registrations using the strict (exact / boundary-substring) matcher.
 * Useful when an earlier fuzzy match cross-contaminated the roster.
 */
function api_resetAndResyncLeague(league_id) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin'], league_id);
    return resetAndResyncLeagueFromCR_(league_id);
  });
}

/**
 * One-click: pull CR registrations + create teams for a partner league.
 * Idempotent. Default date window: today − 90 days .. today + 180 days.
 */
function api_setupTeamsFromCR(league_id, opts) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin'], league_id);
    return setupTeamsFromCR_(league_id, opts || {});
  });
}

function api_crAutoAssign() {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin']);
    return autoAssignStagedByEventName_();
  });
}

function api_crClearStaging() {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin']);
    return clearStagedRegistrations_();
  });
}

function api_crUnassignStaged(reg_ids) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin']);
    return unassignStagedRegistrations_(reg_ids);
  });
}

/**
 * GET-only explorer for the CourtReserve API. Lets an admin poke at arbitrary
 * paths and see the raw response. POST/PUT/DELETE are deliberately not exposed
 * here — those should land in named endpoints with their own validation so we
 * don't accidentally mutate CR data from a freeform UI.
 */
function api_crExplore(path, query) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin']);
    if (!path || typeof path !== 'string') throw new Error('path required');
    const r = crFetch_('GET', path, { query: query || null });
    crLogSync_({
      kind: 'explore', method: 'GET', path: path, http_status: r.status,
      status: r.status >= 200 && r.status < 300 ? 'ok' : 'error',
      message: r.status >= 200 && r.status < 300 ? '' : crSample_(r.body),
    });
    const items = Array.isArray(r.body) ? r.body :
                  (r.body && Array.isArray(r.body.Items))  ? r.body.Items :
                  (r.body && Array.isArray(r.body.Data))   ? r.body.Data  :
                  (r.body && Array.isArray(r.body.Result)) ? r.body.Result : null;
    const ct = r.headers && (r.headers['Content-Type'] || r.headers['content-type']) || '';
    return {
      status:        r.status,
      url:           r.url,
      content_type:  String(ct),
      body_bytes:    (r.raw || '').length,
      body:          r.body,
      raw:           r.raw || '',
      headers:       r.headers || {},
      first_item:    items && items.length ? items[0] : null,
      keys_first:    items && items.length ? Object.keys(items[0] || {}) : (r.body && typeof r.body === 'object' ? Object.keys(r.body) : []),
      count:         items ? items.length : null,
    };
  });
}

function api_exportCsv(league_id, kind, opts) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator'], league_id);
    const csv = exportCsv_(league_id, kind, opts || {});
    const league = getLeagueById_(league_id);
    const wk = opts && opts.week_number ? '_w' + opts.week_number : '';
    const fname = (league ? league.name.replace(/[^a-z0-9]+/gi, '_') : 'export') +
                  '_' + kind + wk + '_' +
                  Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyyMMdd_HHmmss') +
                  '.csv';
    return { filename: fname, csv: csv };
  });
}

/* ----- Public (no role required) ----- */

/**
 * Public read-only endpoints — no role check. Safe to call from the public
 * standings page where the visitor may not be a signed-in operator/admin.
 * Only expose data that's appropriate for public consumption (standings/league
 * names); never expose PII like emails or phone numbers.
 */
function api_publicListLeagues() {
  return wrap_(() => {
    const leagues = listLeagues_();
    // Strip sensitive fields; only return what's needed for the standings page.
    return leagues.map(l => ({
      league_id:    l.league_id,
      name:         l.name,
      full_name:    l.full_name,
      format_type:  l.format_type,
      day_of_week:  l.day_of_week,
      start_time:   l.start_time,
      level:        l.level,
      season_label: l.season_label,
      status:       l.status,
    }));
  });
}

function api_publicGetStandings(league_id) {
  return wrap_(() => {
    if (!league_id) throw new Error('league_id required');
    const league = getLeagueById_(league_id);
    if (!league) throw new Error('League not found');
    const raw = recomputeStandings_(league_id);
    // Strip internal IDs from the public response.
    const standings = raw.map(s => {
      const out = Object.assign({}, s);
      delete out.player_id;
      delete out.team_id;
      delete out.player_1_id;
      delete out.player_2_id;
      delete out.weeks;
      delete out.rows;
      return out;
    });
    return {
      league: {
        league_id:   league.league_id,
        name:        league.name,
        full_name:   league.full_name,
        format_type: league.format_type,
        day_of_week: league.day_of_week,
        start_time:  league.start_time,
        level:       league.level,
        season_label:league.season_label,
      },
      standings: standings,
    };
  });
}

/* ----------------- internal ----------------- */
function wrap_(fn) {
  try {
    // google.script.run can't transmit Date objects — the whole response
    // becomes null silently. JSON-roundtrip coerces Dates to ISO strings
    // (and drops `undefined`, which is also unsupported on the wire).
    const data = fn();
    return { ok: true, data: JSON.parse(JSON.stringify(data)) };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}
