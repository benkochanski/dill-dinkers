/**
 * CSV exports for a league.
 *
 * Returns CSV as a string (the API wraps it in a download blob via
 * google.script.run on the client).
 */

const EXPORT_KINDS = ['roster', 'teams', 'scores', 'standings', 'subs', 'dupr', 'dupr_week'];

/**
 * @param {string} league_id
 * @param {string} kind
 * @param {Object} opts  optional — for dupr_week: { week_number, event_label }
 */
function exportCsv_(league_id, kind, opts) {
  if (EXPORT_KINDS.indexOf(kind) === -1) throw new Error('Unknown export kind: ' + kind);
  const league = getLeagueById_(league_id);
  if (!league) throw new Error('League not found: ' + league_id);

  let headers, rows;
  switch (kind) {
    case 'roster':    ({ headers, rows } = exportRoster_(league_id)); break;
    case 'teams':     ({ headers, rows } = exportTeams_(league_id)); break;
    case 'scores':    ({ headers, rows } = exportScores_(league_id)); break;
    case 'standings': ({ headers, rows } = exportStandings_(league_id, league)); break;
    case 'subs':      ({ headers, rows } = exportSubs_(league_id)); break;
    case 'dupr':      ({ headers, rows } = exportDuprAll_(league_id, league, opts || {})); break;
    case 'dupr_week': ({ headers, rows } = exportDuprWeek_(league_id, league, opts || {})); break;
  }
  return toCsv_(headers, rows);
}

function exportRoster_(league_id) {
  const list = listRoster_(league_id);
  const headers = ['player_id', 'full_name', 'email', 'phone', 'level', 'team_id', 'roster_status', 'dupr_id'];
  const rows = list.map(p => headers.map(h => p[h] != null ? p[h] : ''));
  return { headers, rows };
}

function exportTeams_(league_id) {
  const teams = listTeams_(league_id);
  const players = getObjects_('Players');
  const byId = {};
  players.forEach(p => { byId[p.player_id] = p; });
  const headers = ['team_id', 'team_name', 'player_1_name', 'player_1_email', 'player_2_name', 'player_2_email'];
  const rows = teams.map(t => {
    const p1 = byId[t.player_1_id] || {};
    const p2 = byId[t.player_2_id] || {};
    return [t.team_id, t.team_name, p1.full_name || '', p1.email || '', p2.full_name || '', p2.email || ''];
  });
  return { headers, rows };
}

function exportScores_(league_id) {
  const games = listGames_({ league_id });
  const players = getObjects_('Players');
  const teams = getObjects_('Teams');
  const pById = {}; players.forEach(p => { pById[p.player_id] = p; });
  const tById = {}; teams.forEach(t => { tById[t.team_id] = t; });
  const headers = [
    'game_id', 'play_date', 'week_number', 'round_number', 'group_number',
    'court_number', 't1_label', 't1_score', 't2_label', 't2_score', 'winner',
    'status', 'entered_by', 'entered_at',
  ];
  const rows = games.map(g => {
    const t1Label = g.t1_team_id ? (tById[g.t1_team_id] || {}).team_name :
      [(pById[g.t1_player_1_id] || {}).full_name, (pById[g.t1_player_2_id] || {}).full_name].filter(Boolean).join(' & ');
    const t2Label = g.t2_team_id ? (tById[g.t2_team_id] || {}).team_name :
      [(pById[g.t2_player_1_id] || {}).full_name, (pById[g.t2_player_2_id] || {}).full_name].filter(Boolean).join(' & ');
    return [
      g.game_id, g.play_date, g.week_number, g.round_number, g.group_number,
      g.court_number, t1Label, g.t1_score, t2Label, g.t2_score, g.winner,
      g.status, g.entered_by, g.entered_at,
    ];
  });
  return { headers, rows };
}

function exportStandings_(league_id, league) {
  const data = recomputeStandings_(league_id);
  if (league.format_type === 'partner') {
    const headers = ['rank', 'team_name', 'player_1_name', 'player_2_name',
      'wins', 'losses', 'games_back', 'point_diff', 'point_pct', 'games_played'];
    const rows = data.map(s => headers.map(h => s[h] != null ? s[h] : ''));
    return { headers, rows };
  }
  const headers = ['rank', 'full_name', 'level', 'wins', 'games_played',
    'win_pct', 'w_bonus', 'points', 'point_pct', 'p_bonus', 'score', 'weeks_played'];
  const rows = data.map(s => headers.map(h => s[h] != null ? s[h] : ''));
  return { headers, rows };
}

function exportSubs_(league_id) {
  const list = listSubstitutions_({ league_id });
  const headers = ['sub_id', 'play_date', 'week_number', 'absent_player_name',
    'substitute_player_name', 'recorded_by', 'recorded_at', 'email_sent', 'notes'];
  const rows = list.map(s => headers.map(h => s[h] != null ? s[h] : ''));
  return { headers, rows };
}

/* ----- DUPR exports ----- */

const DUPR_HEADERS = [
  'matchType', 'scoreType', 'event', 'date',
  'playerA1', 'playerA1DuprId', 'playerA2', 'playerA2DuprId',
  'playerB1', 'playerB1DuprId', 'playerB2', 'playerB2DuprId',
  'teamAGame1', 'teamBGame1',
  'teamAGame2', 'teamBGame2',
  'teamAGame3', 'teamBGame3',
  'teamAGame4', 'teamBGame4',
  'teamAGame5', 'teamBGame5',
];

/**
 * DUPR-format CSV for all completed games in a league.
 * One row per game; only game 1 score columns are populated (single-game-to-21).
 * Names are left blank — only DUPR IDs are written, matching the DUPR template.
 */
function exportDuprAll_(league_id, league, opts) {
  return buildDuprRows_(league_id, league, listGames_({ league_id }).filter(g => g.status === 'complete'), opts);
}

/**
 * DUPR-format CSV for a single week's completed games.
 */
function exportDuprWeek_(league_id, league, opts) {
  const week = opts.week_number;
  if (week == null || week === '') throw new Error('week_number required for dupr_week export');
  const games = listGames_({ league_id, week_number: week }).filter(g => g.status === 'complete');
  return buildDuprRows_(league_id, league, games, opts);
}

function buildDuprRows_(league_id, league, games, opts) {
  const players = getObjects_('Players');
  const byId = {};
  players.forEach(p => { byId[p.player_id] = p; });

  // Default event label: "<league.name> — Week <n>" (or just the league name).
  const defaultEvent = league.name + (opts.week_number ? ' — Week ' + opts.week_number :
                                      (opts.event_label ? '' : ''));
  const event = opts.event_label || defaultEvent;

  const rows = games.map(g => {
    const date = g.play_date ? String(g.play_date).slice(0, 10) : '';
    const a1 = byId[g.t1_player_1_id] || {};
    const a2 = byId[g.t1_player_2_id] || {};
    const b1 = byId[g.t2_player_1_id] || {};
    const b2 = byId[g.t2_player_2_id] || {};
    return [
      'D', 'SIDEOUT', event, date,
      '', a1.dupr_id || '', '', a2.dupr_id || '',
      '', b1.dupr_id || '', '', b2.dupr_id || '',
      g.t1_score, g.t2_score,
      '', '', '', '', '', '', '', '',
    ];
  });
  return { headers: DUPR_HEADERS, rows };
}

/** Quote a CSV cell per RFC 4180 — quote if contains comma/quote/newline. */
function csvCell_(v) {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCsv_(headers, rows) {
  const lines = [headers.map(csvCell_).join(',')];
  rows.forEach(r => lines.push(r.map(csvCell_).join(',')));
  return lines.join('\n');
}
