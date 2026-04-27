/**
 * Registrations — inbound from external system + approval into rosters.
 *
 * Workflow:
 *   1. importRegistrationsFromSheet_(externalSheetId, tabName)
 *      Reads rows from another spreadsheet (your existing "Players By
 *      League" tab) and inserts them into the Registrations tab with
 *      status='pending'. Idempotent: skips rows already imported (matched
 *      by member_email + league_full_name).
 *   2. listPendingRegistrations_(filter)
 *      Group by league_full_name for review.
 *   3. approveRegistration_(registration_id, league_id, opts)
 *      For ladder: creates Player (or finds by email) + adds to Roster.
 *      For partner: same, plus Team handling — see below.
 *   4. bulkApprove_(registration_ids, league_id) — convenience.
 *
 * Partner team handling on approval:
 *   - Each registration row carries partner_status + partner_name + team_name.
 *   - If team_name is set, we look up an existing Team in this league with
 *     that name. If found, slot the player into player_1_id (if open) or
 *     player_2_id. If not found, create a new Team with this player as P1
 *     (P2 will be filled when the partner is approved).
 *   - "TBD" partner_status leaves team_id blank — admin can pair later.
 */

/**
 * Import registrations from another Google Sheet.
 *
 * @param {string} externalSheetId — full sheet ID (NOT the URL)
 * @param {string} tabName — usually "Players By League"
 * @param {Object} opts
 *    columnMap — override default column-name mapping
 *      {
 *        league_full_name: 'Event Name',
 *        member_number:    'Member Number',
 *        member_email:     'Member Email',
 *        member_phone:     'Member Phone',
 *        full_name:        'Full Name',
 *        club_level:       'DD Club Level',
 *        dupr_id:          'DUPR ID',
 *        partner_status:   'What is your partner status?',
 *        partner_name:     'Partners Name',
 *        team_name:        'Team Name',
 *      }
 * @returns {{ scanned, imported, skipped }}
 */
function importRegistrationsFromSheet_(externalSheetId, tabName, opts) {
  if (!externalSheetId) throw new Error('externalSheetId required');
  tabName = tabName || 'Players By League';
  opts = opts || {};
  const map = Object.assign({
    league_full_name: 'Event Name',
    member_number:    'Member Number',
    member_email:     'Member Email',
    member_phone:     'Member Phone',
    full_name:        'Full Name',
    club_level:       'DD Club Level',
    dupr_id:          'DUPR ID',
    partner_status:   'What is your partner status?',
    partner_name:     'Partners Name',
    team_name:        'Team Name',
  }, opts.columnMap || {});

  const ext = SpreadsheetApp.openById(externalSheetId);
  const sheet = ext.getSheetByName(tabName);
  if (!sheet) throw new Error('Tab not found in external sheet: ' + tabName);

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2) return { scanned: 0, imported: 0, skipped: 0 };

  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const colIdx = {};
  Object.keys(map).forEach(k => { colIdx[k] = headers.indexOf(map[k]); });

  const data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

  const existing = getObjects_('Registrations');
  const existingKey = new Set(existing.map(r =>
    String(r.member_email || '').toLowerCase().trim() + '|' +
    String(r.league_full_name || '').trim()
  ));

  const stamp = nowStamp_();
  const toInsert = [];
  let scanned = 0, skipped = 0;

  data.forEach(row => {
    const get = k => colIdx[k] >= 0 ? row[colIdx[k]] : '';
    const league_full_name = String(get('league_full_name') || '').trim();
    const member_email     = String(get('member_email') || '').toLowerCase().trim();
    if (!league_full_name || !member_email) return;
    scanned++;
    const key = member_email + '|' + league_full_name;
    if (existingKey.has(key)) { skipped++; return; }
    existingKey.add(key);
    toInsert.push({
      registration_id: makeId_('registration'),
      league_full_name: league_full_name,
      member_number:    get('member_number'),
      member_email:     member_email,
      member_phone:     get('member_phone'),
      full_name:        get('full_name'),
      club_level:       get('club_level'),
      dupr_id:          get('dupr_id'),
      partner_status:   get('partner_status'),
      partner_name:     get('partner_name'),
      team_name:        get('team_name'),
      imported_at:      stamp,
      status:           'pending',
      league_id:        '',
      reviewed_by:      '',
      reviewed_at:      '',
    });
  });

  appendObjects_('Registrations', toInsert);
  audit_('registrations_import', 'sheet', externalSheetId,
    null, { scanned, imported: toInsert.length, skipped });
  return { scanned, imported: toInsert.length, skipped };
}

/** Pending registrations, grouped by league_full_name for review. */
function listPendingRegistrations_() {
  const pending = getObjects_('Registrations').filter(r => r.status === 'pending');
  const groups = {};
  pending.forEach(r => {
    const key = r.league_full_name || '(unknown)';
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  });
  return Object.keys(groups).sort().map(name => ({
    league_full_name: name,
    count: groups[name].length,
    rows: groups[name],
  }));
}

/**
 * Approve one registration into a target league.
 *  - upserts Player by email
 *  - creates Roster row (idempotent)
 *  - for partner: if team_name is set, slots into existing Team or creates one
 */
function approveRegistration_(registration_id, league_id) {
  const reg = getObjects_('Registrations').find(r => r.registration_id === registration_id);
  if (!reg) throw new Error('Registration not found: ' + registration_id);
  if (reg.status !== 'pending') throw new Error('Registration already ' + reg.status);

  const league = getLeagueById_(league_id);
  if (!league) throw new Error('League not found: ' + league_id);

  // Player: upsert by email.
  const player = upsertPlayer_({
    full_name:      reg.full_name,
    email:          reg.member_email,
    phone:          reg.member_phone,
    dupr_id:        reg.dupr_id,
    club_member_id: reg.member_number,
    level:          reg.club_level,
  });

  let team_id = '';
  if (league.format_type === 'partner' && reg.team_name) {
    team_id = slotIntoTeam_(league_id, String(reg.team_name).trim(), player.player_id);
  }

  addToRoster_(league_id, player.player_id, { team_id, level: reg.club_level });

  updateWhere_('Registrations',
    r => r.registration_id === registration_id,
    r => {
      r.status = 'approved';
      r.league_id = league_id;
      r.reviewed_by = activeUserEmail_();
      r.reviewed_at = nowStamp_();
    });

  audit_('registration_approve', 'registration', registration_id, 'pending',
    { league_id, player_id: player.player_id, team_id });
  return { player, team_id };
}

function rejectRegistration_(registration_id, reason) {
  updateWhere_('Registrations',
    r => r.registration_id === registration_id,
    r => {
      r.status = 'rejected';
      r.reviewed_by = activeUserEmail_();
      r.reviewed_at = nowStamp_();
    });
  audit_('registration_reject', 'registration', registration_id, 'pending', { reason: reason || '' });
}

/**
 * Find or create a team in this league by name. Slot the player into P1
 * if open, else P2, else throw (team already full = different player
 * registered with same team_name).
 * @returns the team_id
 */
function slotIntoTeam_(league_id, team_name, player_id) {
  const teams = listTeams_(league_id);
  let team = teams.find(t => String(t.team_name).trim().toLowerCase() === team_name.toLowerCase());

  if (!team) {
    const team_id = makeId_('team');
    appendObjects_('Teams', [{
      team_id:     team_id,
      league_id:   league_id,
      team_name:   team_name,
      player_1_id: player_id,
      player_2_id: '',
      created_at:  nowStamp_(),
    }]);
    audit_('team_create', 'team', team_id, null, { league_id, team_name, player_1_id: player_id });
    return team_id;
  }

  // Team exists — slot the player in if not already there.
  if (team.player_1_id === player_id || team.player_2_id === player_id) return team.team_id;
  if (!team.player_1_id) {
    updateWhere_('Teams', t => t.team_id === team.team_id, t => { t.player_1_id = player_id; });
  } else if (!team.player_2_id) {
    updateWhere_('Teams', t => t.team_id === team.team_id, t => { t.player_2_id = player_id; });
  } else {
    throw new Error('Team "' + team_name + '" already has 2 players; cannot add ' + player_id);
  }
  return team.team_id;
}
