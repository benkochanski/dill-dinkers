/**
 * Migration_CRMemberKey.js
 *
 * Migrates player identity from the generated `player_id` (and the parallel
 * `ext_<member_number>` system) to CourtReserve's `cr_member_id` as the single
 * canonical key.
 *
 * STEP 1 — auditCrMemberKeyMigration():  READ-ONLY.
 *   Proves every Players row and every historical player reference (including
 *   ext_<member_number> IDs in Games/Session_Groups/Overrides/Substitutions)
 *   can resolve to a cr_member_id via the CR_Members directory. Lists anything
 *   that can't, so we never orphan game history. Run this FIRST, from the
 *   Apps Script editor → function dropdown → auditCrMemberKeyMigration → Run →
 *   View execution log.
 *
 * No mutation happens in step 1. The actual migration (step 2+) is gated on a
 * clean audit + a full sheet backup.
 */

/* ============================================================
 * Shared resolver — current identifier → canonical cr_member_id
 * ============================================================ */

/**
 * Build lookups over CR_Members so we can resolve any of the identifier
 * spaces (cr_member_id, membership_number, email, name) to the canonical
 * cr_member_id.
 */
function _buildCrMemberResolver_() {
  const members = getObjects_('CR_Members');
  const byCrId   = {};   // cr_member_id (string) -> member
  const byMship  = {};   // membership_number (string) -> member
  const byEmail  = {};   // lowercased email -> member
  const byName   = {};   // lowercased "first last" -> member (may collide)
  const nameCollisions = {};

  members.forEach(m => {
    const crId  = String(m.cr_member_id || '').trim();
    const mship = String(m.membership_number || '').trim();
    const email = String(m.email || '').trim().toLowerCase();
    const name  = (String(m.first_name || '').trim() + ' ' + String(m.last_name || '').trim())
                    .trim().toLowerCase().replace(/\s+/g, ' ');
    if (crId)  byCrId[crId]   = m;
    if (mship) byMship[mship] = m;
    if (email) byEmail[email] = m;
    if (name) {
      if (byName[name]) nameCollisions[name] = (nameCollisions[name] || 1) + 1;
      else byName[name] = m;
    }
  });

  /**
   * Resolve any identifier string to a cr_member_id. Tries, in order:
   *   1. exact cr_member_id
   *   2. membership_number
   * Returns { cr_member_id, via } or null.
   */
  const resolveId = raw => {
    const id = String(raw || '').trim();
    if (!id) return null;
    if (byCrId[id])  return { cr_member_id: String(byCrId[id].cr_member_id).trim(), via: 'cr_member_id' };
    if (byMship[id]) return { cr_member_id: String(byMship[id].cr_member_id).trim(), via: 'membership_number' };
    return null;
  };

  /** Resolve by email (lowercased). */
  const resolveEmail = raw => {
    const e = String(raw || '').trim().toLowerCase();
    if (e && byEmail[e]) return { cr_member_id: String(byEmail[e].cr_member_id).trim(), via: 'email' };
    return null;
  };

  /** Resolve by full name (lowercased). Flags collisions as low-confidence. */
  const resolveName = raw => {
    const n = String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!n) return null;
    if (nameCollisions[n]) return { cr_member_id: null, via: 'name_collision', ambiguous: true, name: n };
    if (byName[n]) return { cr_member_id: String(byName[n].cr_member_id).trim(), via: 'name' };
    return null;
  };

  return {
    memberCount: members.length,
    byCrId, byMship, byEmail, byName, nameCollisions,
    resolveId, resolveEmail, resolveName,
  };
}

/**
 * Resolve one Players row to a cr_member_id using all available signals.
 * Returns { cr_member_id, via } or { cr_member_id: null, reason }.
 */
function _resolvePlayerToCrId_(p, R) {
  // Identity is the CourtReserve member ID ONLY — never email or name.
  // club_member_id / player_id may hold either the cr_member_id or the
  // membership_number; both resolve to the canonical cr_member_id.
  const byId = R.resolveId(p.club_member_id) || R.resolveId(p.player_id);
  if (byId) return byId;
  return { cr_member_id: null, reason: 'unresolved' };
}

/* ============================================================
 * STEP 1 — read-only audit
 * ============================================================ */

function auditCrMemberKeyMigration() {
  const R = _buildCrMemberResolver_();
  Logger.log('CR_Members directory size: %s', R.memberCount);
  if (R.memberCount === 0) {
    Logger.log('⚠ CR_Members is EMPTY. Run the CourtReserve members sync before migrating.');
    return { ok: false, error: 'CR_Members empty' };
  }

  // ---- Players rows ----
  const players = getObjects_('Players');
  const playerMap = {};          // player_id -> cr_member_id (resolved)
  const unresolvedPlayers = [];
  const collisions = {};         // target cr_member_id -> [player_ids] (detect many-to-one merges)
  let resolvedCount = 0;
  players.forEach(p => {
    const pid = String(p.player_id || '').trim();
    if (!pid) return;
    const r = _resolvePlayerToCrId_(p, R);
    if (r.cr_member_id) {
      playerMap[pid] = r.cr_member_id;
      resolvedCount++;
      (collisions[r.cr_member_id] = collisions[r.cr_member_id] || []).push({ pid: pid, name: p.full_name, via: r.via });
    } else {
      unresolvedPlayers.push({ player_id: pid, name: p.full_name, email: p.email, club_member_id: p.club_member_id, is_guest: p.is_guest, reason: r.reason });
    }
  });

  // ---- ext_<member_number> references in game-bearing tabs ----
  const extIds = {};   // ext_<mn> -> count
  const collectExt = (tab, cols) => {
    getObjects_(tab).forEach(row => {
      cols.forEach(c => {
        const v = String(row[c] || '').trim();
        if (v.indexOf('ext_') === 0) extIds[v] = (extIds[v] || 0) + 1;
      });
    });
  };
  collectExt('Games', ['t1_player_1_id', 't1_player_2_id', 't2_player_1_id', 't2_player_2_id']);
  collectExt('Session_Groups', ['player_id', 'original_player_id']);
  collectExt('Session_Game_Overrides', ['player_id', 'original_player_id']);
  collectExt('Substitutions', ['absent_player_id', 'substitute_player_id']);

  const unresolvedExt = [];
  let extResolved = 0;
  Object.keys(extIds).forEach(extId => {
    const mn = extId.slice(4);
    const r = R.resolveId(mn);   // member_number → cr_member_id via membership_number (or cr_member_id)
    if (r) extResolved++;
    else unresolvedExt.push({ ext_id: extId, member_number: mn, refs: extIds[extId] });
  });

  // ---- Many-to-one merges (multiple player_ids → same cr_member_id) ----
  const merges = Object.keys(collisions)
    .filter(crId => collisions[crId].length > 1)
    .map(crId => ({ cr_member_id: crId, rows: collisions[crId] }));

  // ---- Report ----
  Logger.log('================ PLAYERS ================');
  Logger.log('Total Players rows: %s', players.length);
  Logger.log('Resolved to cr_member_id: %s', resolvedCount);
  Logger.log('UNRESOLVED: %s', unresolvedPlayers.length);
  unresolvedPlayers.slice(0, 50).forEach(u =>
    Logger.log('  ✗ %s | name="%s" email="%s" club_member_id="%s" guest=%s reason=%s',
      u.player_id, u.name, u.email, u.club_member_id, u.is_guest, u.reason));
  if (unresolvedPlayers.length > 50) Logger.log('  ...and %s more', unresolvedPlayers.length - 50);

  Logger.log('================ MERGES (many player_ids -> one cr_member_id) ================');
  Logger.log('Merge groups: %s', merges.length);
  merges.slice(0, 30).forEach(m =>
    Logger.log('  ⤳ %s <= %s', m.cr_member_id, m.rows.map(r => r.pid + '("' + r.name + '")').join(', ')));

  Logger.log('================ ext_<member_number> REFERENCES ================');
  Logger.log('Distinct ext_ ids in games/sessions/subs: %s', Object.keys(extIds).length);
  Logger.log('Resolved via CR_Members: %s', extResolved);
  Logger.log('UNRESOLVED ext_: %s', unresolvedExt.length);
  unresolvedExt.slice(0, 50).forEach(u =>
    Logger.log('  ✗ %s (member_number=%s, %s refs)', u.ext_id, u.member_number, u.refs));

  Logger.log('================ NAME COLLISIONS in CR_Members ================');
  Logger.log('Names appearing on >1 member: %s', Object.keys(R.nameCollisions).length);

  const summary = {
    cr_members: R.memberCount,
    players_total: players.length,
    players_resolved: resolvedCount,
    players_unresolved: unresolvedPlayers.length,
    merge_groups: merges.length,
    ext_distinct: Object.keys(extIds).length,
    ext_resolved: extResolved,
    ext_unresolved: unresolvedExt.length,
    name_collisions: Object.keys(R.nameCollisions).length,
    clean: unresolvedPlayers.length === 0 && unresolvedExt.length === 0,
  };
  Logger.log('================ SUMMARY ================');
  Logger.log(JSON.stringify(summary, null, 2));
  Logger.log(summary.clean
    ? '✅ CLEAN — every player and ext_ reference maps to a cr_member_id. Safe to proceed to backup + migrate.'
    : '⚠ NOT CLEAN — resolve the unresolved rows above before migrating (sync CR_Members, fix bad club_member_ids, or handle exceptions).');
  return summary;
}

/* ============================================================
 * STEP 2 — build the canonical key map + merged Players rows
 * ============================================================ */

/**
 * Returns the full migration plan (no writes):
 *   playerToCanonical : { old_player_id -> canonical_key }
 *   extToCanonical    : { 'ext_<mn>'   -> canonical_key }
 *   newPlayers        : merged + enriched Players rows (player_id = canonical)
 *   fallbacks         : player_ids kept unchanged (unresolvable)
 *   merges            : groups where >1 old row collapsed to one cr_member_id
 */
function _resolveCanonicalKeys_() {
  const R = _buildCrMemberResolver_();
  const players = getObjects_('Players');

  // 1. Resolve each player to a canonical key (cr_member_id or fallback=own id).
  const playerToCanonical = {};
  const fallbacks = [];
  const groups = {};   // canonical -> [players]
  players.forEach(p => {
    const pid = String(p.player_id || '').trim();
    if (!pid) return;
    const r = _resolvePlayerToCrId_(p, R);
    const canonical = r.cr_member_id || pid;   // fallback: keep own id
    if (!r.cr_member_id) fallbacks.push({ player_id: pid, name: p.full_name });
    playerToCanonical[pid] = canonical;
    (groups[canonical] = groups[canonical] || []).push(p);
  });

  // 2. Resolve ext_<mn> ids.
  const extToCanonical = {};
  const extIds = {};
  const collectExt = (tab, cols) => getObjects_(tab).forEach(row =>
    cols.forEach(c => { const v = String(row[c] || '').trim(); if (v.indexOf('ext_') === 0) extIds[v] = 1; }));
  collectExt('Games', ['t1_player_1_id', 't1_player_2_id', 't2_player_1_id', 't2_player_2_id']);
  collectExt('Session_Groups', ['player_id', 'original_player_id']);
  collectExt('Session_Game_Overrides', ['player_id', 'original_player_id']);
  collectExt('Substitutions', ['absent_player_id', 'substitute_player_id']);
  Object.keys(extIds).forEach(extId => {
    const hit = R.resolveId(extId.slice(4));
    extToCanonical[extId] = hit ? hit.cr_member_id : extId;   // fallback: keep ext_
  });

  // 3. Build merged + enriched Players rows.
  const PLAYER_COLS = SCHEMA.Players.columns;
  const newPlayers = [];
  const merges = [];
  const firstNonEmpty = (rows, key) => {
    for (let i = 0; i < rows.length; i++) {
      const v = rows[i][key];
      if (v != null && String(v).trim() !== '') return v;
    }
    return '';
  };
  Object.keys(groups).forEach(canonical => {
    const rows = groups[canonical];
    if (rows.length > 1) merges.push({ canonical: canonical, rows: rows.map(r => ({ pid: r.player_id, name: r.full_name })) });
    const isCrKey = !!R.byCrId[canonical];   // canonical is a real cr_member_id
    const m = isCrKey ? R.byCrId[canonical] : null;
    const out = {};
    PLAYER_COLS.forEach(c => { out[c] = firstNonEmpty(rows, c); });
    out.player_id = canonical;
    if (m) {
      // CR_Members is authoritative for identity fields.
      const f = String(m.first_name || '').trim();
      const l = String(m.last_name || '').trim();
      out.first_name     = f || out.first_name;
      out.last_name      = l || out.last_name;
      out.full_name      = (f + ' ' + l).trim() || out.full_name;
      out.email          = String(m.email || '').trim() || out.email;
      out.phone          = String(m.phone || '').trim() || out.phone;
      out.gender         = String(m.gender || '').trim() || out.gender;
      out.club_member_id = canonical;
      out.is_guest       = '';          // real CR member, no longer a guest
    }
    // active TRUE if any merged row active.
    out.active = rows.some(r => r.active === true || r.active === 'TRUE' || r.active === 'true') ? true : (out.active || '');
    out.created_at = rows.map(r => r.created_at).filter(Boolean).sort()[0] || out.created_at;
    newPlayers.push(out);
  });

  return { R, playerToCanonical, extToCanonical, newPlayers, fallbacks, merges };
}

/** Map any old id (player_id or ext_) to its canonical key. */
function _canon_(oldId, plan) {
  const id = String(oldId || '').trim();
  if (!id) return id;
  if (id.indexOf('ext_') === 0) return plan.extToCanonical[id] || id;
  return plan.playerToCanonical[id] || id;
}

const _REF_TABS_ = {
  Games:                  ['t1_player_1_id', 't1_player_2_id', 't2_player_1_id', 't2_player_2_id'],
  Rosters:                ['player_id'],
  Teams:                  ['player_1_id', 'player_2_id'],
  Session_Groups:         ['player_id', 'original_player_id'],
  Session_Game_Overrides: ['player_id', 'original_player_id'],
  Substitutions:          ['absent_player_id', 'substitute_player_id'],
};

/* ============================================================
 * STEP 3 — dry-run (default) and execute
 * ============================================================ */

/** Dry-run: logs the complete change plan, writes NOTHING. */
function migrateToCrMemberKey() {
  return _runMigration_(false);
}

/** Execute: backs up the whole spreadsheet, then applies the migration. */
function executeCrMemberKeyMigration() {
  return _runMigration_(true);
}

function _runMigration_(commit) {
  const plan = _resolveCanonicalKeys_();
  Logger.log('=== CR-member-key migration %s ===', commit ? 'EXECUTE' : 'DRY-RUN');
  Logger.log('Players: %s rows -> %s canonical rows (%s merge groups, %s fallbacks kept)',
    getObjects_('Players').length, plan.newPlayers.length, plan.merges.length, plan.fallbacks.length);
  plan.merges.forEach(m => Logger.log('  merge %s <= %s', m.canonical, m.rows.map(r => r.pid + '("' + r.name + '")').join(', ')));

  // Reference-tab change counts.
  const changes = {};
  Object.keys(_REF_TABS_).forEach(tab => {
    const cols = _REF_TABS_[tab];
    const rows = getObjects_(tab);
    let changed = 0;
    rows.forEach(row => {
      cols.forEach(c => {
        const oldV = String(row[c] || '').trim();
        if (!oldV) return;
        const newV = _canon_(oldV, plan);
        if (newV !== oldV) changed++;
      });
    });
    changes[tab] = { rows: rows.length, cells_changed: changed };
    Logger.log('  %s: %s cells changed across %s rows', tab, changed, rows.length);
  });

  if (!commit) {
    Logger.log('DRY-RUN complete. Review above. Run executeCrMemberKeyMigration() to apply (it backs up first).');
    return { dryRun: true, newPlayers: plan.newPlayers.length, merges: plan.merges.length, fallbacks: plan.fallbacks.length, changes: changes };
  }

  // ---- EXECUTE ----
  const backupUrl = _backupSpreadsheet_();
  Logger.log('Backup created: %s', backupUrl);

  // 1. Rewrite reference tabs in place.
  Object.keys(_REF_TABS_).forEach(tab => {
    const cols = _REF_TABS_[tab];
    updateWhere_(tab, () => true, row => {
      cols.forEach(c => {
        const oldV = String(row[c] || '').trim();
        if (oldV) { const nv = _canon_(oldV, plan); if (nv !== oldV) row[c] = nv; }
      });
    });
  });

  // 2. Dedupe Rosters by (league_id, player_id) — merges can create duplicates.
  const seenRoster = {};
  const rosterKeep = [];
  getObjects_('Rosters').forEach(r => {
    const k = String(r.league_id) + '|' + String(r.player_id);
    if (seenRoster[k]) return;
    seenRoster[k] = true;
    rosterKeep.push(r);
  });
  overwriteObjects_('Rosters', rosterKeep);

  // 3. Replace the Players tab with the merged/enriched rows.
  overwriteObjects_('Players', plan.newPlayers);

  // 4. Bump every league version so standings recompute with the new keys
  //    (standings cache is keyed by league_id + version).
  try {
    getObjects_('Leagues').forEach(l => {
      if (l.league_id) bumpLeagueVersion_(l.league_id);
    });
    cacheBustAll_();
  } catch (e) { Logger.log('cache bust warning: %s', e && e.message); }

  audit_('migrate_cr_member_key', 'system', 'players', null,
    { new_players: plan.newPlayers.length, merges: plan.merges.length, fallbacks: plan.fallbacks.length, backup: backupUrl });
  Logger.log('✅ EXECUTE complete. Players: %s rows. Backup: %s', plan.newPlayers.length, backupUrl);
  return { dryRun: false, backup: backupUrl, newPlayers: plan.newPlayers.length, merges: plan.merges.length };
}

/**
 * Back up the player-referencing tabs by duplicating each one inside the same
 * workbook (uses only the spreadsheet scope — no DriveApp permission needed).
 * Returns the list of backup tab names. To restore, copy a backup tab's data
 * back over the original. Google Sheets' built-in version history (File →
 * Version history) is an additional full-workbook safety net.
 */
function _backupSpreadsheet_() {
  const ss = getMasterSpreadsheet_();
  const stamp = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyyMMdd_HHmmss');
  const tabs = ['Players', 'Games', 'Rosters', 'Teams',
                'Session_Groups', 'Session_Game_Overrides', 'Substitutions'];
  const made = [];
  tabs.forEach(name => {
    const sh = ss.getSheetByName(name);
    if (!sh) return;
    const copy = sh.copyTo(ss);
    const bkName = ('BK_' + name + '_' + stamp).slice(0, 90);
    copy.setName(bkName);
    made.push(bkName);
  });
  return made.join(', ');
}
