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

function publicListLeagues_() {
  const leagues = listLeagues_()
    .filter(l => l.status !== 'archived' && l.status !== 'draft');
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
  return {
    league_id:    l.league_id,
    slug:         leagueSlug_(l),
    name:         l.name,
    full_name:    l.full_name,
    format_type:  l.format_type,
    day_of_week:  l.day_of_week,
    start_time:   l.start_time,
    level:        l.level,
    season_label: l.season_label,
    status:       l.status,
    weeks_count:  Number(l.weeks_count) || weeks.length || 0,
    current_week: currentWeek,
  };
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
  const standings = raw.map(s => {
    const out = Object.assign({}, s);
    delete out.player_id;
    delete out.player_1_id;
    delete out.player_2_id;
    delete out.weeks;
    delete out.rows;
    return out;
  });

  let weekly = null;
  if (league.format_type === 'partner') {
    weekly = computePartnerWeeklyBreakdown_(league_id);
  }
  return { league: summary, standings, weekly };
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

  games.forEach(g => {
    const wkIdx = weeks.indexOf(Number(g.week_number));
    if (wkIdx < 0) return;
    const s1 = Number(g.t1_score), s2 = Number(g.t2_score);
    if (Number.isNaN(s1) || Number.isNaN(s2)) return;
    if (g.t1_team_id && byTeam[g.t1_team_id]) {
      if (s1 > s2) byTeam[g.t1_team_id][wkIdx].w++;
      else if (s1 < s2) byTeam[g.t1_team_id][wkIdx].l++;
    }
    if (g.t2_team_id && byTeam[g.t2_team_id]) {
      if (s2 > s1) byTeam[g.t2_team_id][wkIdx].w++;
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
        return {
          round:       Number(m.game_number),
          court:       m.court_number === '' ? null : Number(m.court_number),
          t1_team_id:  m.t1_team_id,
          t2_team_id:  m.t2_team_id,
          t1_name:     t1 ? t1.team_name : '',
          t2_name:     t2 ? t2.team_name : '',
          t1_slug:     t1 ? teamSlug_(t1) : '',
          t2_slug:     t2 ? teamSlug_(t2) : '',
          played:      !!(game && game.status === 'complete'),
          t1_score:    game && game.status === 'complete'
            ? (game.t1_team_id === m.t1_team_id ? Number(game.t1_score) : Number(game.t2_score))
            : null,
          t2_score:    game && game.status === 'complete'
            ? (game.t1_team_id === m.t1_team_id ? Number(game.t2_score) : Number(game.t1_score))
            : null,
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
    Number(b.week_number) - Number(a.week_number) ||
    Number(a.round_number) - Number(b.round_number));

  if (league.format_type === 'partner') {
    const teams = getObjects_('Teams').filter(t => t.league_id === league_id);
    const teamById = {}; teams.forEach(t => { teamById[t.team_id] = t; });
    const players = getObjects_('Players');
    const playerById = {}; players.forEach(p => { playerById[p.player_id] = p; });
    return {
      league: summary,
      results: games.map(g => ({
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
        t1_players: [g.t1_player_1_id, g.t1_player_2_id]
          .filter(Boolean)
          .map(pid => playerById[pid] ? playerById[pid].full_name : ''),
        t2_players: [g.t2_player_1_id, g.t2_player_2_id]
          .filter(Boolean)
          .map(pid => playerById[pid] ? playerById[pid].full_name : ''),
        t1_score:   Number(g.t1_score),
        t2_score:   Number(g.t2_score),
        winner:     Number(g.winner) || 0,
      })),
    };
  }

  // Ladder: just team-less player rows.
  const players = getObjects_('Players');
  const playerById = {}; players.forEach(p => { playerById[p.player_id] = p; });
  return {
    league: summary,
    results: games.map(g => ({
      game_id:    g.game_id,
      week:       Number(g.week_number),
      round:      Number(g.round_number),
      group:      g.group_number === '' ? null : Number(g.group_number),
      court:      g.court_number === '' ? null : Number(g.court_number),
      play_date:  formatDate_(g.play_date),
      t1_players: [g.t1_player_1_id, g.t1_player_2_id]
        .filter(Boolean)
        .map(pid => playerById[pid] ? playerById[pid].full_name : ''),
      t2_players: [g.t2_player_1_id, g.t2_player_2_id]
        .filter(Boolean)
        .map(pid => playerById[pid] ? playerById[pid].full_name : ''),
      t1_score:   Number(g.t1_score),
      t2_score:   Number(g.t2_score),
      winner:     Number(g.winner) || 0,
    })),
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
      won = myScore > oppScore;
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
