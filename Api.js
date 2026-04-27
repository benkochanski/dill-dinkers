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
    return listLeagues_();
  });
}

function api_getLeague(league_id) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator'], league_id);
    const league = getLeagueById_(league_id);
    if (!league) throw new Error('League not found');
    return {
      league: league,
      schedule: getLeagueSchedule_(league_id),
      roster: listRoster_(league_id),
      teams: league.format_type === 'partner' ? listTeams_(league_id) : [],
    };
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
    return recomputeStandings_(league_id);
  });
}

function api_createLeague(input) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin']);
    return createLeague_(input);
  });
}

function api_addPlayerToLeague(league_id, playerInput, opts) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin'], league_id);
    const player = upsertPlayer_(playerInput);
    addToRoster_(league_id, player.player_id, opts || {});
    return player;
  });
}

function api_createTeam(league_id, team_name, player_1_id, player_2_id) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin'], league_id);
    return createTeam_(league_id, team_name, player_1_id, player_2_id);
  });
}

function api_generateSchedule(league_id, opts) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin'], league_id);
    return generatePartnerSchedule_(league_id, opts || {});
  });
}

function api_listScheduledMatches(league_id, week_number) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator'], league_id);
    return listScheduledMatches_(league_id, week_number);
  });
}

/* ----- Registrations ----- */

function api_listPendingRegistrations() {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin']);
    return listPendingRegistrations_();
  });
}

function api_importRegistrations(externalSheetId, tabName) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin']);
    return importRegistrationsFromSheet_(externalSheetId, tabName);
  });
}

function api_approveRegistration(registration_id, league_id) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin'], league_id);
    return approveRegistration_(registration_id, league_id);
  });
}

function api_rejectRegistration(registration_id, reason) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin']);
    rejectRegistration_(registration_id, reason);
    return { ok: true };
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

/* ----- Bulk Email ----- */

function api_bulkEmail(input) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin'], input && input.league_id);
    return bulkEmailLeague_(input);
  });
}

/* ----- CSV Export ----- */

/* ----- Bulk approve + Roles + Audit ----- */

function api_bulkApproveByName(league_full_name, league_id) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin'], league_id);
    return bulkApproveByName_(league_full_name, league_id);
  });
}

function api_listRoles() {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin']);
    return listRoles_();
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

function api_exportCsv(league_id, kind) {
  return wrap_(() => {
    const user = getCurrentUser_();
    requireRole_(user, ['admin', 'operator'], league_id);
    const csv = exportCsv_(league_id, kind);
    const league = getLeagueById_(league_id);
    const fname = (league ? league.name.replace(/[^a-z0-9]+/gi, '_') : 'export') +
                  '_' + kind + '_' +
                  Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyyMMdd_HHmmss') +
                  '.csv';
    return { filename: fname, csv: csv };
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
