/**
 * Public read-only data layer for the leagues.dilldinkersct.com site.
 *
 * Everything here is exposed via doGet(?page=json&action=...). No PII
 * (emails, phones) ever leaves these functions — we only return display
 * data. CORS is permitted by ContentService when the script is deployed
 * as "Anyone (even anonymous) can access".
 *
 * Internal-only IDs are kept (we need them for client-side routing) but
 * everything else is stripped to the minimum the public site renders.
 */

/* ========================= router ========================= */

function publicJsonRouter_(params) {
  const action = String(params.action || '').toLowerCase();
  switch (action) {
    case 'leagues':   return publicListLeagues_();
    case 'league':    return publicGetLeague_(params.lid);
    case 'standings': return publicGetStandings_(params.lid);
    case 'schedule':  return publicGetSchedule_(params.lid);
    case 'results':   return publicGetResults_(params.lid);
    case 'teams':     return publicGetTeams_(params.lid);
    case 'team':      return publicGetTeam_(params.lid, params.tid);
    default:          throw new Error('Unknown action: ' + action);
  }
}

/* ========================= leagues ========================= */

// Defunct leagues that should never appear on the public site, even if their
// status field still says "active". Match against the start of `name`.
const DEFUNCT_LEAGUE_PREFIXES_ = [
  'Club Match',
  'Age 60+ Coed Social',
];

function isDefunctLeague_(l) {
  const name = String(l.name || '').toLowerCase();
  return DEFUNCT_LEAGUE_PREFIXES_.some(p => name.startsWith(p.toLowerCase()));
}

function publicListLeagues_() {
  const leagues = listLeagues_()
    .filter(l => l.status !== 'archived' && l.status !== 'draft')
    .filter(l => !isDefunctLeague_(l));
  return leagues.map(l => publicLeagueSummary_(l));
}

function publicGetLeague_(league_id) {
  if (!league_id) throw new Error('lid required');
  const league = getLeagueById_(league_id);
  if (!league) throw new Error('League not found');
  return publicLeagueSummary_(league);
}

function publicLeagueSummary_(l) {
  const weeks = getLeagueSchedule_(l.league_id);
  const today = new Date();
  let currentWeek = null;
  weeks.forEach(w => {
    const d = w.play_date instanceof Date
      ? w.play_date
      : (w.play_date ? new Date(w.play_date) : null);
    if (d && d <= today) currentWeek = Number(w.week_number);
  });
  // Day + time are derived from cr_event_start (the actual scheduled
  // CourtReserve event datetime). The legacy day_of_week / start_time text
  // fields are used as fallbacks only — operators don't always populate them.
  // Build a sorted list of {week, date} for display ("4/7", "4/14", ...).
  const sessionDates = weeks
    .filter(w => !w.skip_week)
    .sort((a, b) => Number(a.week_number) - Number(b.week_number))
    .map(w => {
      const d = w.play_date instanceof Date ? w.play_date : (w.play_date ? new Date(w.play_date) : null);
      if (!d || isNaN(d.getTime())) return null;
      return { week: Number(w.week_number), date: (d.getMonth() + 1) + '/' + d.getDate() };
    })
    .filter(Boolean);

  return {
    league_id:     l.league_id,
    slug:          leagueSlug_(l),
    name:          l.name,
    full_name:     l.full_name,
    format_type:   l.format_type,
    day_of_week:   dayFromCrStart_(l.cr_event_start) || l.day_of_week || '',
    start_time:    timeFromCrStart_(l.cr_event_start) || l.start_time || '',
    level:         l.level,
    season_label:  l.season_label,
    status:        l.status,
    weeks_count:   Number(l.weeks_count) || weeks.length || 0,
    current_week:  currentWeek,
    session_dates: sessionDates,
  };
}

function dayFromCrStart_(d) {
  const dt = parseCrDate_(d);
  if (!dt) return '';
  return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][dt.getDay()];
}

function timeFromCrStart_(d) {
  const dt = parseCrDate_(d);
  if (!dt) return '';
  const tz = (typeof CONFIG !== 'undefined' && CONFIG.TIMEZONE) || Session.getScriptTimeZone();
  return Utilities.formatDate(dt, tz, 'h:mm a');
}

function parseCrDate_(d) {
  if (!d) return null;
  if (d instanceof Date) return isNaN(d.getTime()) ? null : d;
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? null : dt;
}

function leagueSlug_(l) {
  return String(l.name || l.league_id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function teamSlug_(t) {
  return String(t.team_name || t.team_id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/* ========================= standings ========================= */

function publicGetStandings_(league_id) {
  if (!league_id) throw new Error('lid required');
  const league = getLeagueById_(league_id);
  if (!league) throw new Error('League not found');
  const summary = publicLeagueSummary_(league);

  const raw = recomputeStandings_(league_id);

  let weekly = null;
  let weeks = [];

  if (league.format_type === 'partner') {
    weekly = computePartnerWeeklyBreakdown_(league_id);
  } else {
    // Ladder: compute per-week rank for each rostered player.
    const allGames = listGames_({ league_id }).filter(g => g.status === 'complete');
    // Use weeks_count to always show all weeks even if not yet played.
    const totalWeeks = Number(league && league.weeks_count) || 0;
    if (totalWeeks > 0) {
      weeks = Array.from({ length: totalWeeks }, (_, i) => i + 1);
    } else {
      const schedWeeks = getLeagueSchedule_(league_id);
      weeks = schedWeeks.map(w => Number(w.week_number)).filter(n => !isNaN(n)).sort((a, b) => a - b);
      if (!weeks.length) {
        const weekSet = {};
        allGames.forEach(g => { if (g.week_number != null && g.week_number !== '') weekSet[String(g.week_number)] = true; });
        weeks = Object.keys(weekSet).map(Number).sort((a, b) => a - b);
      }
    }

    // Bonus config for this league — used so weekly ranking matches the
    // season formula (composite Score with W%/P% bonuses).
    const bonusCfg = {};
    getObjects_('Bonus_Config').forEach(c => {
      if (c.league_id === league_id) bonusCfg[String(c.group_rank)] = c;
    });
    const bonusStartsWeek = Number(league && league.bonus_starts_week) || 3;

    // weeklyStats[pid][wk] = { wins, points, games, w_bonus, p_bonus }
    const weeklyStats = {};
    function bumpWeekly_(pid, wk, my, their, group_number) {
      if (!weeklyStats[pid]) weeklyStats[pid] = {};
      if (!weeklyStats[pid][wk]) {
        weeklyStats[pid][wk] = { wins: 0, points: 0, games: 0, w_bonus: 0, p_bonus: 0 };
      }
      const w = weeklyStats[pid][wk];
      w.games  += 1;
      w.points += my;
      const won = my > their;
      if (won) w.wins += 1;
      // Bonuses kick in from bonus_starts_week onward, scaled by the group's
      // multiplier — same rule as computeBonuses_ in Standings.js.
      if (Number(wk) >= bonusStartsWeek) {
        const c = bonusCfg[String(group_number)];
        if (c) {
          w.p_bonus += Number(c.p_multiplier_per_game) || 0;
          if (won) w.w_bonus += Number(c.w_multiplier_per_win) || 0;
        }
      }
    }
    allGames.forEach(g => {
      const wk = Number(g.week_number);
      const s1 = Number(g.t1_score), s2 = Number(g.t2_score);
      if (isNaN(s1) || isNaN(s2)) return;
      const grp = g.group_number;
      [g.t1_player_1_id, g.t1_player_2_id].filter(Boolean).forEach(pid =>
        bumpWeekly_(pid, wk, s1, s2, grp));
      [g.t2_player_1_id, g.t2_player_2_id].filter(Boolean).forEach(pid =>
        bumpWeekly_(pid, wk, s2, s1, grp));
    });

    // Rank rostered players within each week using composite Score:
    //   W%    = (wins + w_bonus) / games
    //   P%    = (points + p_bonus) / (games * 11)
    //   Score = 0.6 * W% + 0.4 * P%
    const POINTS_PER_GAME = 11;
    const rosterPids = raw.map(s => s.player_id);
    const weeklyRank = {};  // pid -> { wk: rank }
    weeks.forEach(wk => {
      const participants = rosterPids
        .filter(pid => weeklyStats[pid] && weeklyStats[pid][wk])
        .map(pid => {
          const w = weeklyStats[pid][wk];
          const winPct   = w.games ? (w.wins   + w.w_bonus) / w.games : 0;
          const pointPct = w.games ? (w.points + w.p_bonus) / (w.games * POINTS_PER_GAME) : 0;
          return { pid, score: 0.6 * winPct + 0.4 * pointPct, wins: w.wins, points: w.points };
        });
      participants.sort((a, b) =>
        b.score - a.score || b.wins - a.wins || b.points - a.points);
      participants.forEach((p, i) => {
        if (!weeklyRank[p.pid]) weeklyRank[p.pid] = {};
        weeklyRank[p.pid][wk] = i + 1;
      });
    });

    raw.forEach(s => {
      s._weekly = weeks.map(w =>
        (weeklyRank[s.player_id] && weeklyRank[s.player_id][w] != null)
          ? weeklyRank[s.player_id][w] : null
      );
    });
  }

  const standings = raw.map(s => {
    const out = Object.assign({}, s);
    const weekly_rank = out._weekly || [];
    delete out.player_id;
    delete out.player_1_id;
    delete out.player_2_id;
    delete out.weeks;
    delete out.rows;
    delete out._weekly;
    out.weekly_rank = weekly_rank;
    return out;
  });

  return { league: summary, standings, weeks, weekly };
}

/**
 * For each team in a partner league, returns per-week W-L counts.
 *   { weeks: [1,2,3,...], by_team: { team_id: [{w,l}, ...] } }
 */
function computePartnerWeeklyBreakdown_(league_id) {
  const games = listGames_({ league_id }).filter(g => g.status === 'complete');
  const weeksSet = {};
  games.forEach(g => { if (g.week_number != null && g.week_number !== '') weeksSet[String(g.week_number)] = true; });
  const weeks = Object.keys(weeksSet).map(Number).sort((a, b) => a - b);

  const teams = getObjects_('Teams').filter(t => t.league_id === league_id);
  const byTeam = {};
  teams.forEach(t => {
    byTeam[t.team_id] = weeks.map(() => ({ w: 0, l: 0 }));
  });

  const forced = getPartnerForcedLossMap_(league_id);
  games.forEach(g => {
    const wkIdx = weeks.indexOf(Number(g.week_number));
    if (wkIdx < 0) return;
    const s1 = Number(g.t1_score), s2 = Number(g.t2_score);
    if (Number.isNaN(s1) || Number.isNaN(s2)) return;
    const t1F = isPartnerForcedLoss_(forced, g.t1_team_id, g.week_number);
    const t2F = isPartnerForcedLoss_(forced, g.t2_team_id, g.week_number);
    if (g.t1_team_id && byTeam[g.t1_team_id]) {
      if (t1F) byTeam[g.t1_team_id][wkIdx].l++;
      else if (t2F) byTeam[g.t1_team_id][wkIdx].w++;
      else if (s1 > s2) byTeam[g.t1_team_id][wkIdx].w++;
      else if (s1 < s2) byTeam[g.t1_team_id][wkIdx].l++;
    }
    if (g.t2_team_id && byTeam[g.t2_team_id]) {
      if (t2F) byTeam[g.t2_team_id][wkIdx].l++;
      else if (t1F) byTeam[g.t2_team_id][wkIdx].w++;
      else if (s2 > s1) byTeam[g.t2_team_id][wkIdx].w++;
      else if (s2 < s1) byTeam[g.t2_team_id][wkIdx].l++;
    }
  });
  return { weeks, by_team: byTeam };
}

/* ========================= schedule ========================= */

function publicGetSchedule_(league_id) {
  if (!league_id) throw new Error('lid required');
  const league = getLeagueById_(league_id);
  if (!league) throw new Error('League not found');
  const summary = publicLeagueSummary_(league);

  const weeks = getLeagueSchedule_(league_id);
  const matches = getObjects_('Match_Schedule').filter(m => m.league_id === league_id);
  const teams = getObjects_('Teams').filter(t => t.league_id === league_id);
  const teamById = {}; teams.forEach(t => { teamById[t.team_id] = t; });
  const games = listGames_({ league_id });
  const forced = league.format_type === 'partner' ? getPartnerForcedLossMap_(league_id) : null;

  const out = weeks.map(w => {
    const wkMatches = matches
      .filter(m => Number(m.week_number) === Number(w.week_number))
      .sort((a, b) => Number(a.game_number) - Number(b.game_number) ||
                       Number(a.court_number) - Number(b.court_number));
    return {
      week_number: Number(w.week_number),
      play_date:   formatDate_(w.play_date),
      skip:        !!w.skip_week,
      notes:       w.notes || '',
      matches: wkMatches.map(m => {
        const t1 = teamById[m.t1_team_id];
        const t2 = teamById[m.t2_team_id];
        const game = games.find(g =>
          Number(g.week_number) === Number(m.week_number) &&
          Number(g.round_number) === Number(m.game_number) &&
          ((g.t1_team_id === m.t1_team_id && g.t2_team_id === m.t2_team_id) ||
           (g.t1_team_id === m.t2_team_id && g.t2_team_id === m.t1_team_id)));
        const played = !!(game && game.status === 'complete');
        const t1Score = played ? (game.t1_team_id === m.t1_team_id ? Number(game.t1_score) : Number(game.t2_score)) : null;
        const t2Score = played ? (game.t1_team_id === m.t1_team_id ? Number(game.t2_score) : Number(game.t1_score)) : null;
        let winner = 0;
        if (played) {
          if (t1Score > t2Score) winner = 1;
          else if (t2Score > t1Score) winner = 2;
          if (forced) {
            const t1F = isPartnerForcedLoss_(forced, m.t1_team_id, m.week_number);
            const t2F = isPartnerForcedLoss_(forced, m.t2_team_id, m.week_number);
            if (t1F && !t2F) winner = 2;
            else if (t2F && !t1F) winner = 1;
          }
        }
        return {
          round:       Number(m.game_number),
          court:       m.court_number === '' ? null : Number(m.court_number),
          t1_team_id:  m.t1_team_id,
          t2_team_id:  m.t2_team_id,
          t1_name:     t1 ? t1.team_name : '',
          t2_name:     t2 ? t2.team_name : '',
          t1_slug:     t1 ? teamSlug_(t1) : '',
          t2_slug:     t2 ? teamSlug_(t2) : '',
          played:      played,
          t1_score:    t1Score,
          t2_score:    t2Score,
          winner:      winner,
        };
      }),
    };
  });
  return { league: summary, weeks: out };
}

/* ========================= results ========================= */

function publicGetResults_(league_id) {
  if (!league_id) throw new Error('lid required');
  const league = getLeagueById_(league_id);
  if (!league) throw new Error('League not found');
  const summary = publicLeagueSummary_(league);

  const games = listGames_({ league_id }).filter(g => g.status === 'complete');
  games.sort((a, b) =>
    Number(b.week_number)  - Number(a.week_number)  ||
    normalizeHalf_(a.half) - normalizeHalf_(b.half) ||
    Number(a.round_number) - Number(b.round_number) ||
    Number(a.group_number) - Number(b.group_number));

  const players = getObjects_('Players');
  const playerById = {}; players.forEach(p => { playerById[p.player_id] = p; });

  // Fallback for ext_ IDs (CR attendees not yet materialized into Players).
  const extByMemberNum = {};
  getObjects_('CR_Attendance').forEach(a => {
    const mn = String(a.member_number || '').trim();
    if (mn && !extByMemberNum[mn]) {
      const fn = (String(a.first_name || '').trim() + ' ' + String(a.last_name || '').trim()).trim();
      extByMemberNum[mn] = fn || ('Guest ' + mn);
    }
  });

  function resolveName_(pid) {
    if (!pid) return '';
    if (playerById[pid]) return displayPlayerName_(playerById[pid], extByMemberNum);
    if (String(pid).startsWith('ext_')) {
      const mn = String(pid).slice(4);
      return extByMemberNum[mn] || ('Guest ' + mn);
    }
    return '';
  }

  if (league.format_type === 'partner') {
    const teams = getObjects_('Teams').filter(t => t.league_id === league_id);
    const teamById = {}; teams.forEach(t => { teamById[t.team_id] = t; });
    const forced = getPartnerForcedLossMap_(league_id);
    const teamRoster = {};
    teams.forEach(t => {
      teamRoster[t.team_id] = new Set([t.player_1_id, t.player_2_id].filter(Boolean));
    });
    const isSubFor = (team_id, pid) => {
      if (!pid) return false;
      const r = teamRoster[team_id];
      return !r || !r.has(pid);
    };
    return {
      league: summary,
      results: games.map(g => {
        const t1F = isPartnerForcedLoss_(forced, g.t1_team_id, g.week_number);
        const t2F = isPartnerForcedLoss_(forced, g.t2_team_id, g.week_number);
        let winner = Number(g.winner) || 0;
        if (t1F && !t2F) winner = 2;
        else if (t2F && !t1F) winner = 1;
        const t1Ids = [g.t1_player_1_id, g.t1_player_2_id].filter(Boolean);
        const t2Ids = [g.t2_player_1_id, g.t2_player_2_id].filter(Boolean);
        return {
          game_id:   g.game_id,
          week:      Number(g.week_number),
          round:     Number(g.round_number),
          court:     g.court_number === '' ? null : Number(g.court_number),
          play_date: formatDate_(g.play_date),
          t1_team_id: g.t1_team_id,
          t2_team_id: g.t2_team_id,
          t1_name:    teamById[g.t1_team_id] ? teamById[g.t1_team_id].team_name : '',
          t2_name:    teamById[g.t2_team_id] ? teamById[g.t2_team_id].team_name : '',
          t1_slug:    teamById[g.t1_team_id] ? teamSlug_(teamById[g.t1_team_id]) : '',
          t2_slug:    teamById[g.t2_team_id] ? teamSlug_(teamById[g.t2_team_id]) : '',
          t1_players: t1Ids.map(resolveName_),
          t2_players: t2Ids.map(resolveName_),
          t1_player_subs: t1Ids.map(pid => isSubFor(g.t1_team_id, pid)),
          t2_player_subs: t2Ids.map(pid => isSubFor(g.t2_team_id, pid)),
          t1_score:   Number(g.t1_score),
          t2_score:   Number(g.t2_score),
          winner:     winner,
        };
      }),
    };
  }

  // Ladder: team-less player rows. Mark subs per game so the public weekly
  // standings page can show an asterisk for non-rostered fill-ins.
  const roster = getObjects_('Rosters').filter(r => r.league_id === league_id && r.status === 'active');
  const rosteredIds = new Set(roster.map(r => r.player_id));
  const subKeys = new Set();
  getObjects_('Substitutions').filter(s => s.league_id === league_id).forEach(s => {
    if (s.substitute_player_id && s.week_number != null && s.week_number !== '') {
      subKeys.add(s.substitute_player_id + ':' + String(s.week_number));
    }
  });
  const isSubForWeek = (pid, wk) => {
    if (!pid) return false;
    if (subKeys.has(pid + ':' + String(wk))) return true;
    return !rosteredIds.has(pid);
  };

  // Bonus config exposed for the SPA's per-week standings calculator so it
  // can produce bonus-adjusted W%/P%/Score that matches the season standings.
  const bonusByRank = {};
  getObjects_('Bonus_Config').forEach(c => {
    if (c.league_id !== league_id) return;
    bonusByRank[String(c.group_rank)] = {
      w_multiplier_per_win:   Number(c.w_multiplier_per_win) || 0,
      p_multiplier_per_game:  Number(c.p_multiplier_per_game) || 0,
    };
  });

  return {
    league: summary,
    bonus_starts_week: Number(league.bonus_starts_week) || 3,
    bonus_config:      bonusByRank,
    results: games.map(g => {
      const t1Ids = [g.t1_player_1_id, g.t1_player_2_id].filter(Boolean);
      const t2Ids = [g.t2_player_1_id, g.t2_player_2_id].filter(Boolean);
      return {
        game_id:    g.game_id,
        week:       Number(g.week_number),
        half:       normalizeHalf_(g.half),
        round:      Number(g.round_number),
        group:      g.group_number === '' ? null : Number(g.group_number),
        court:      g.court_number === '' ? null : Number(g.court_number),
        play_date:  formatDate_(g.play_date),
        t1_players: t1Ids.map(resolveName_),
        t2_players: t2Ids.map(resolveName_),
        t1_player_subs: t1Ids.map(pid => isSubForWeek(pid, g.week_number)),
        t2_player_subs: t2Ids.map(pid => isSubForWeek(pid, g.week_number)),
        t1_score:   Number(g.t1_score),
        t2_score:   Number(g.t2_score),
        winner:     Number(g.winner) || 0,
      };
    }),
  };
}

/* ========================= teams (list + detail) ========================= */

function publicGetTeams_(league_id) {
  if (!league_id) throw new Error('lid required');
  const league = getLeagueById_(league_id);
  if (!league) throw new Error('League not found');
  if (league.format_type !== 'partner') {
    return { league: publicLeagueSummary_(league), teams: [] };
  }
  const summary = publicLeagueSummary_(league);
  const teams = getObjects_('Teams').filter(t => t.league_id === league_id);
  const standings = recomputeStandings_(league_id);
  const standByTeam = {};
  standings.forEach(s => { standByTeam[s.team_id] = s; });

  const players = getObjects_('Players');
  const playerById = {}; players.forEach(p => { playerById[p.player_id] = p; });

  const out = teams.map(t => {
    const s = standByTeam[t.team_id] || {};
    return {
      team_id:       t.team_id,
      slug:          teamSlug_(t),
      team_name:     t.team_name,
      player_1_name: playerById[t.player_1_id] ? playerById[t.player_1_id].full_name : '',
      player_2_name: playerById[t.player_2_id] ? playerById[t.player_2_id].full_name : '',
      rank:          s.rank || null,
      wins:          s.wins || 0,
      losses:        s.losses || 0,
      games_back:    s.games_back || 0,
      point_diff:    s.point_diff || 0,
    };
  });
  out.sort((a, b) => (a.rank || 9999) - (b.rank || 9999));
  return { league: summary, teams: out };
}

function publicGetTeam_(league_id, team_id) {
  if (!league_id) throw new Error('lid required');
  if (!team_id) throw new Error('tid required');
  const league = getLeagueById_(league_id);
  if (!league) throw new Error('League not found');
  if (league.format_type !== 'partner') throw new Error('Team pages are partner-format only');
  const summary = publicLeagueSummary_(league);

  const teams = getObjects_('Teams').filter(t => t.league_id === league_id);
  const team  = teams.find(t => t.team_id === team_id);
  if (!team) throw new Error('Team not found');
  const teamById = {}; teams.forEach(t => { teamById[t.team_id] = t; });

  const players = getObjects_('Players');
  const playerById = {}; players.forEach(p => { playerById[p.player_id] = p; });

  const standings = recomputeStandings_(league_id);
  const standing = standings.find(s => s.team_id === team_id) || null;
  if (standing) {
    delete standing.player_1_id;
    delete standing.player_2_id;
    delete standing.weeks;
  }

  // Schedule + results for this team (every match it appears in).
  const matches = getObjects_('Match_Schedule')
    .filter(m => m.league_id === league_id &&
                 (m.t1_team_id === team_id || m.t2_team_id === team_id));
  matches.sort((a, b) =>
    Number(a.week_number) - Number(b.week_number) ||
    Number(a.game_number) - Number(b.game_number));
  const games = listGames_({ league_id });
  const forced = getPartnerForcedLossMap_(league_id);

  const schedule = matches.map(m => {
    const oppId = m.t1_team_id === team_id ? m.t2_team_id : m.t1_team_id;
    const opp = teamById[oppId];
    const game = games.find(g =>
      g.status === 'complete' &&
      Number(g.week_number) === Number(m.week_number) &&
      Number(g.round_number) === Number(m.game_number) &&
      ((g.t1_team_id === m.t1_team_id && g.t2_team_id === m.t2_team_id) ||
       (g.t1_team_id === m.t2_team_id && g.t2_team_id === m.t1_team_id)));
    let myScore = null, oppScore = null, won = null;
    let myPlayers = [team.player_1_id, team.player_2_id];
    let oppPlayers = opp ? [opp.player_1_id, opp.player_2_id] : [];
    if (game) {
      const meIsT1 = game.t1_team_id === team_id;
      myScore  = meIsT1 ? Number(game.t1_score) : Number(game.t2_score);
      oppScore = meIsT1 ? Number(game.t2_score) : Number(game.t1_score);
      const meForced  = isPartnerForcedLoss_(forced, team_id, game.week_number);
      const oppForced = isPartnerForcedLoss_(forced, oppId,   game.week_number);
      if (meForced) won = false;
      else if (oppForced) won = true;
      else won = myScore > oppScore;
      myPlayers  = meIsT1
        ? [game.t1_player_1_id, game.t1_player_2_id]
        : [game.t2_player_1_id, game.t2_player_2_id];
      oppPlayers = meIsT1
        ? [game.t2_player_1_id, game.t2_player_2_id]
        : [game.t1_player_1_id, game.t1_player_2_id];
    }
    return {
      week:           Number(m.week_number),
      round:          Number(m.game_number),
      court:          m.court_number === '' ? null : Number(m.court_number),
      play_date:      formatDate_(m.play_date),
      opponent_id:    oppId,
      opponent_name:  opp ? opp.team_name : '',
      opponent_slug:  opp ? teamSlug_(opp) : '',
      played:         !!game,
      my_score:       myScore,
      opp_score:      oppScore,
      won:            won,
      my_players:     myPlayers
        .filter(Boolean)
        .map(pid => playerById[pid] ? playerById[pid].full_name : ''),
      opp_players:    oppPlayers
        .filter(Boolean)
        .map(pid => playerById[pid] ? playerById[pid].full_name : ''),
    };
  });

  // Head-to-head: aggregate W-L + remaining vs every other team.
  const h2hMap = {};
  teams.forEach(o => {
    if (o.team_id === team_id) return;
    h2hMap[o.team_id] = {
      opponent_id:   o.team_id,
      opponent_name: o.team_name,
      opponent_slug: teamSlug_(o),
      wins:   0,
      losses: 0,
      points_for:    0,
      points_against:0,
      remaining: 0,
    };
  });
  schedule.forEach(s => {
    const h = h2hMap[s.opponent_id];
    if (!h) return;
    if (s.played) {
      if (s.won) h.wins++;
      else if (s.won === false) h.losses++;
      h.points_for     += Number(s.my_score)  || 0;
      h.points_against += Number(s.opp_score) || 0;
    } else {
      h.remaining++;
    }
  });
  const h2h = Object.keys(h2hMap)
    .map(k => h2hMap[k])
    .sort((a, b) => a.opponent_name.localeCompare(b.opponent_name));

  // Sub history for this team's players in this league.
  const teamPlayerIds = new Set([team.player_1_id, team.player_2_id].filter(Boolean));
  const subs = getObjects_('Substitutions')
    .filter(s => s.league_id === league_id &&
                 (teamPlayerIds.has(s.absent_player_id) ||
                  teamPlayerIds.has(s.substitute_player_id)));
  subs.sort((a, b) =>
    Number(a.week_number || 0) - Number(b.week_number || 0));
  const subHistory = subs.map(s => ({
    week:           Number(s.week_number) || null,
    play_date:      formatDate_(s.play_date),
    absent_name:    s.absent_player_name || '',
    substitute_name:s.substitute_player_name || '',
    notes:          s.notes || '',
    direction:      teamPlayerIds.has(s.absent_player_id) ? 'out' : 'in',
  }));

  return {
    league:   summary,
    team: {
      team_id:       team.team_id,
      slug:          teamSlug_(team),
      team_name:     team.team_name,
      player_1_id:   team.player_1_id,
      player_2_id:   team.player_2_id,
      player_1_name: playerById[team.player_1_id] ? playerById[team.player_1_id].full_name : '',
      player_2_name: playerById[team.player_2_id] ? playerById[team.player_2_id].full_name : '',
    },
    standing,
    schedule,
    h2h,
    subs: subHistory,
  };
}

/* ========================= helpers ========================= */

function formatDate_(d) {
  if (!d) return '';
  if (d instanceof Date) {
    return Utilities.formatDate(d, CONFIG.TIMEZONE || Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(d).slice(0, 10);
}
