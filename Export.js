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

  const teamsById = {};
  getObjects_('Teams').forEach(t => { teamsById[t.team_id] = t; });

  // Build absent_player_id → substitute_player_id map keyed by week_number
  // AND by play_date. A substitution replaces the absent player in every game
  // they would have played that week. We key by both so a Substitutions row
  // missing one of the two fields still matches.
  const normWk = v => {
    if (v == null) return '';
    if (v instanceof Date) return '';
    const n = Number(v);
    return Number.isFinite(n) && String(v).trim() !== '' ? String(n) : String(v).trim();
  };
  const normDate = v => {
    if (!v) return '';
    if (v instanceof Date) {
      const tz = Session.getScriptTimeZone() || 'America/New_York';
      return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
    }
    const s = String(v).trim();
    const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
    return iso ? iso[1] : s;
  };
  const subByWeek = {};
  const subByDate = {};
  listSubstitutions_({ league_id }).forEach(s => {
    const absent = String(s.absent_player_id || '').trim();
    const sub = String(s.substitute_player_id || '').trim();
    if (!absent || !sub) return;
    const wk = normWk(s.week_number);
    if (wk) {
      if (!subByWeek[wk]) subByWeek[wk] = {};
      subByWeek[wk][absent] = sub;
    }
    const d = normDate(s.play_date);
    if (d) {
      if (!subByDate[d]) subByDate[d] = {};
      subByDate[d][absent] = sub;
    }
  });
  const applySub = (pid, week_number, play_date) => {
    if (!pid) return pid;
    const key = String(pid).trim();
    const wkMap = subByWeek[normWk(week_number)];
    if (wkMap && wkMap[key]) return wkMap[key];
    const dMap = subByDate[normDate(play_date)];
    if (dMap && dMap[key]) return dMap[key];
    return pid;
  };

  const cr = buildCrDuprMap_();

  // Ladder subs are stored in Games with `ext_<member_number>` player IDs (no
  // Players row). Resolve their name from CR_Attendance and their DUPR via
  // cr.byMemberNum so they don't drop out of the export.
  const extByMn = {};
  try {
    getObjects_('CR_Attendance').forEach(a => {
      const mn = String(a.member_number || '').trim();
      if (!mn || extByMn[mn]) return;
      const fn = (String(a.first_name || '').trim() + ' ' + String(a.last_name || '').trim()).trim();
      if (fn) extByMn[mn] = fn;
    });
  } catch (e) {}

  const nameKey = p => {
    const full = (p.full_name || ((p.first_name || '') + ' ' + (p.last_name || ''))).trim();
    return full.toLowerCase().replace(/\s+/g, ' ');
  };
  // DUPR resolution: Players.dupr_id is the single source of truth. CR-derived
  // lookups (registrations) only kick in as a fallback for player IDs that
  // don't have a Players row yet (e.g. ladder ext_ guests).
  const duprFor = pid => {
    if (!pid) return '';
    // Ladder subs in Games are stored as `ext_<member_number>` with no Players
    // row — look DUPR up by CR member number.
    if (String(pid).startsWith('ext_')) {
      const mn = String(pid).slice(4);
      const id = String((mn && cr.byMemberNum[mn]) || '').trim();
      return id ? id.toUpperCase() : '';
    }
    const p = byId[pid] || {};
    const fromPlayer = (p.dupr_id || '').trim();
    if (fromPlayer) return fromPlayer.toUpperCase();
    // Fallbacks when Players.dupr_id is blank — pull from CR registrations.
    const fromCrPid  = cr.byPlayerId[pid];
    const fromMember = p.club_member_id ? cr.byMemberNum[String(p.club_member_id).trim()] : '';
    const fromName   = cr.byName[nameKey(p)];
    const fromEmail  = p.email ? cr.byEmail[String(p.email).trim().toLowerCase()] : '';
    const id = String(fromCrPid || fromMember || fromName || fromEmail || '').trim();
    return id ? id.toUpperCase() : '';
  };
  const nameFor = pid => {
    if (!pid) return '';
    if (String(pid).startsWith('ext_')) {
      const mn = String(pid).slice(4);
      return extByMn[mn] || '';
    }
    const p = byId[pid] || {};
    return (p.full_name || '').trim();
  };

  // For partner games where t*_player_*_id is blank, fall back to the team row.
  const resolvePlayer = (pid, team_id, slot) => {
    if (pid) return pid;
    const t = teamsById[team_id];
    if (!t) return '';
    return slot === 1 ? (t.player_1_id || '') : (t.player_2_id || '');
  };

  // Build week → play_date fallback from the league schedule.
  const weekDateMap = {};
  getLeagueSchedule_(league_id).forEach(w => {
    if (w.week_number != null && w.play_date) {
      weekDateMap[String(w.week_number)] = formatDuprDate_(w.play_date);
    }
  });

  const cleanName = cleanLeagueName_(league.name) + ' League';
  const event = opts.event_label || cleanName;

  const rows = games.map(g => {
    const date = (g.play_date ? formatDuprDate_(g.play_date) : '')
              || weekDateMap[String(g.week_number)] || '';
    const a1 = applySub(resolvePlayer(g.t1_player_1_id, g.t1_team_id, 1), g.week_number, g.play_date);
    const a2 = applySub(resolvePlayer(g.t1_player_2_id, g.t1_team_id, 2), g.week_number, g.play_date);
    const b1 = applySub(resolvePlayer(g.t2_player_1_id, g.t2_team_id, 1), g.week_number, g.play_date);
    const b2 = applySub(resolvePlayer(g.t2_player_2_id, g.t2_team_id, 2), g.week_number, g.play_date);
    return [
      'D', 'SIDEOUT', event, date,
      nameFor(a1), duprFor(a1), nameFor(a2), duprFor(a2),
      nameFor(b1), duprFor(b1), nameFor(b2), duprFor(b2),
      g.t1_score, g.t2_score,
      '', '', '', '', '', '', '', '',
    ];
  });
  return { headers: DUPR_HEADERS, rows };
}

function formatDuprDate_(v) {
  if (!v) return '';
  if (v instanceof Date) {
    const tz = Session.getScriptTimeZone() || 'America/New_York';
    return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  }
  const s = String(v);
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const tz = Session.getScriptTimeZone() || 'America/New_York';
    return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
  }
  return s;
}

// Build DUPR-ID lookups from CR_Registrations. Returns { byPlayerId, byName,
// byEmail } so callers can fall back through join keys (assigned_player_id is
// often unset; name matching covers Players rows created independently).
//
// The DUPR ID lives in user_defined_fields_json as the entry with Label
// "DUPR ID" (typically arr[0]); falls back to arr[0].Value if not labeled.
function buildCrDuprMap_() {
  const byPlayerId = {};
  const byName = {};
  const byEmail = {};
  const byMemberNum = {};
  let regs;
  try { regs = getObjects_('CR_Registrations'); } catch (e) { return { byPlayerId, byName, byEmail, byMemberNum }; }
  regs.forEach(r => {
    const raw = r.user_defined_fields_json;
    if (!raw) return;
    let arr;
    try { arr = JSON.parse(raw); } catch (e) { return; }
    if (!Array.isArray(arr) || !arr.length) return;
    const labeled = arr.find(x => String(x && x.Label || '').trim().toLowerCase() === 'dupr id');
    const val = String((labeled || arr[0]).Value || '').trim();
    if (!val) return;

    const pid = r.assigned_player_id;
    if (pid && !byPlayerId[pid]) byPlayerId[pid] = val;

    const fname = String(r.first_name || '').trim();
    const lname = String(r.last_name || '').trim();
    if (fname || lname) {
      const key = (fname + ' ' + lname).trim().toLowerCase().replace(/\s+/g, ' ');
      if (key && !byName[key]) byName[key] = val;
    }

    const email = String(r.email || '').trim().toLowerCase();
    if (email && !byEmail[email]) byEmail[email] = val;

    // CR member number lookup — used to resolve DUPR for guest subs whose
    // Players row was created with just a name + member_number.
    const mn = String(r.cr_member_id || '').trim();
    if (mn && !byMemberNum[mn]) byMemberNum[mn] = val;
  });
  return { byPlayerId, byName, byEmail, byMemberNum };
}

/**
 * Diagnostic: dump Substitutions and matching Games for a league/week so we
 * can see why a sub isn't being applied in the DUPR export.
 *
 * Usage from Apps Script editor: debugSubsForLeagueWeek_('<league_id>', 3)
 */
function debugSubsForLeagueWeek_(league_id, week_number) {
  const subs = getObjects_('Substitutions').filter(s => s.league_id === league_id);
  Logger.log('Substitutions for league %s (all weeks): %s rows', league_id, subs.length);
  subs.forEach(s => Logger.log('  sub_id=%s week=%s(type=%s) absent_id=%s absent_name=%s → sub_id=%s sub_name=%s',
    s.sub_id, s.week_number, typeof s.week_number, s.absent_player_id, s.absent_player_name,
    s.substitute_player_id, s.substitute_player_name));
  const games = getObjects_('Games').filter(g =>
    g.league_id === league_id && String(g.week_number) === String(week_number) && g.status !== 'voided');
  Logger.log('Games for league %s week %s: %s rows', league_id, week_number, games.length);
  games.forEach(g => Logger.log('  game_id=%s wk=%s(type=%s) t1=[%s,%s] t2=[%s,%s] score=%s-%s',
    g.game_id, g.week_number, typeof g.week_number,
    g.t1_player_1_id, g.t1_player_2_id, g.t2_player_1_id, g.t2_player_2_id,
    g.t1_score, g.t2_score));
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

// Mirrors cleanName() in public-site/index.html: strips trailing parenthesized
// qualifier ("(Team Level 16 Cap)"), leading day prefix ("Mon ", "Sat AM "),
// and the trailing word "League" — so the DUPR event name matches what's
// shown on leagues.dilldinkersct.com.
function cleanLeagueName_(name) {
  let n = String(name || '');
  n = n.replace(/\s*\([^)]*\)\s*$/, '');
  n = n.replace(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b\s*(?:AM|PM)?\s+/i, '');
  n = n.replace(/\s+League\s*$/i, '');
  return n.trim();
}

/**
 * Trace which lookup is producing the DUPR ID for a given player. Pass a
 * name fragment ("Lucas Biran") or a player_id. Logs the full resolution
 * chain so we can see which fallback won.
 */
function debugDuprFor_(needle) {
  const q = String(needle || '').trim().toLowerCase();
  if (!q) { Logger.log('Usage: debugDuprFor_("Lucas Biran")'); return; }
  const players = getObjects_('Players');
  const match = players.find(p =>
    p.player_id === needle ||
    String(p.full_name || '').toLowerCase().includes(q) ||
    String(p.email || '').toLowerCase() === q
  );
  if (!match) { Logger.log('No Player matched: ' + needle); return; }
  const cr = buildCrDuprMap_();
  const nk = (match.full_name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const memId = String(match.club_member_id || '').trim();
  const email = String(match.email || '').trim().toLowerCase();
  const regs = getObjects_('CR_Registrations').filter(r =>
    r.assigned_player_id === match.player_id ||
    String(r.email || '').toLowerCase() === email ||
    String(r.cr_member_id || '') === memId ||
    ((String(r.first_name || '') + ' ' + String(r.last_name || '')).trim().toLowerCase().replace(/\s+/g, ' ') === nk)
  );
  const report = {
    player: {
      player_id: match.player_id,
      full_name: match.full_name,
      email: match.email,
      club_member_id: match.club_member_id,
      dupr_id_on_players_row: match.dupr_id || '(blank)',
    },
    lookup_chain_in_order: {
      '1_fromPlayer_dupr_id':   match.dupr_id || '(blank)',
      '2_fromCrPid':            cr.byPlayerId[match.player_id] || '(none)',
      '3_fromMemberNum':        memId ? (cr.byMemberNum[memId] || '(none)') : '(no club_member_id)',
      '4_fromName':             cr.byName[nk] || '(none)',
      '5_fromEmail':            email ? (cr.byEmail[email] || '(none)') : '(no email)',
    },
    cr_registration_matches: regs.map(r => ({
      cr_reg_id: r.cr_reg_id,
      event_name: r.event_name,
      first_name: r.first_name,
      last_name: r.last_name,
      email: r.email,
      cr_member_id: r.cr_member_id,
      assigned_player_id: r.assigned_player_id,
      assigned_player_id_matches_target: r.assigned_player_id === match.player_id,
      user_defined_fields_json: r.user_defined_fields_json,
    })),
  };
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

// Public wrapper for the Run dropdown (no trailing underscore).
function debugDuprForLucas() { return debugDuprFor_('Lucas Biran'); }
function debugDuprForName(needle) { return debugDuprFor_(needle || 'Lucas Biran'); }
