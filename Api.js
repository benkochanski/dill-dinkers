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
