/**
 * Player roster management.
 *
 * Players (master) is global. Rosters connects a Player to a League with an
 * optional team_id (partner) or null (ladder). One roster row per
 * league × player. status in {active, inactive} for in-season removals.
 */

/**
 * Resolve any CourtReserve identifier to the canonical cr_member_id (which we
 * use as player_id). Tries cr_member_id / club_member_id / member_number
 * (against both the OrganizationMemberId and MembershipNumber spaces in
 * CR_Members), then email. Returns '' if the person isn't a CR member —
 * callers then fall back to a generated id.
 *
 * The CR_Members index is cached per request (Apps Script resets module globals
 * between executions, so this is safe and avoids re-reading 6800+ rows in loops).
 */
var _CR_RESOLVER_CACHE_ = null;
function _crResolver_() {
  if (_CR_RESOLVER_CACHE_) return _CR_RESOLVER_CACHE_;
  const byCrId = {}, byMship = {}, byEmail = {}, memberByCrId = {};
  try {
    getObjects_('CR_Members').forEach(m => {
      const crId  = String(m.cr_member_id || '').trim();
      if (!crId) return;
      const mship = String(m.membership_number || '').trim();
      const email = String(m.email || '').trim().toLowerCase();
      byCrId[crId] = crId;
      memberByCrId[crId] = m;
      if (mship) byMship[mship] = crId;
      if (email) byEmail[email] = crId;
    });
  } catch (e) { /* CR_Members missing — fine, returns empty maps */ }
  // Detect whether the cr_member_id migration has been applied. In a migrated
  // sheet, Players.player_id values ARE cr_member_ids; in an un-migrated sheet
  // they are generated ids (PM…) or ext_…. Until migration is applied we must
  // NOT key new players by cr_member_id — every create-path stays on its legacy
  // behavior so the code matches whatever state the sheet is in.
  let migrated = false;
  try {
    migrated = getObjects_('Players').some(p => byCrId[String(p.player_id || '').trim()]);
  } catch (e) { /* Players missing — treat as un-migrated */ }
  _CR_RESOLVER_CACHE_ = { byCrId, byMship, byEmail, memberByCrId, migrated };
  return _CR_RESOLVER_CACHE_;
}

/** True only once the cr_member_id migration has been applied to the sheet. */
function crKeyingActive_() { return !!_crResolver_().migrated; }

/** Return the CR_Members row for a canonical cr_member_id, or null. */
function crMemberRow_(crId) {
  const R = _crResolver_();
  return R.memberByCrId[String(crId || '').trim()] || null;
}
function canonicalMemberId_(input) {
  // Identity is the CourtReserve member ID ONLY. Email and name are never
  // used to identify a player (per spec). We accept either the
  // OrganizationMemberId (cr_member_id) or the MembershipNumber and resolve
  // both to the canonical cr_member_id via CR_Members.
  const R = _crResolver_();
  if (!R.migrated) return '';   // sheet not migrated — keep legacy keying intact
  const ids = [input.cr_member_id, input.club_member_id, input.member_number];
  for (let i = 0; i < ids.length; i++) {
    const id = String(ids[i] || '').trim();
    if (!id) continue;
    if (R.byCrId[id])  return R.byCrId[id];
    if (R.byMship[id]) return R.byMship[id];
  }
  return '';
}

/**
 * Find or create a player. Identity key is the CourtReserve cr_member_id
 * (used as player_id). Dedup order: canonical cr_member_id, then email.
 * If a player exists, provided fields are updated.
 */
function upsertPlayer_(input) {
  const email = (input.email || '').toLowerCase().trim();
  if (!email && !input.full_name) throw new Error('Need at least email or full_name');

  const all = getObjects_('Players');
  const canonical = canonicalMemberId_(input);
  // Migrated sheet: dedup by CourtReserve member ID ONLY (never email/name).
  // Un-migrated sheet: canonical is '' (keying dormant), so fall back to the
  // legacy email dedup the app has always used — keeps current behavior intact.
  const existing = (canonical && all.find(p => String(p.player_id).trim() === canonical))
                || (email ? all.find(p => (p.email || '').toLowerCase() === email) : null);

  if (existing) {
    const before = Object.assign({}, existing);
    updateWhere_('Players', p => p.player_id === existing.player_id, p => {
      ['full_name', 'first_name', 'last_name', 'phone', 'gender', 'dupr_id',
       'club_member_id', 'level', 'notes'].forEach(k => {
        if (input[k] !== undefined && input[k] !== '') p[k] = input[k];
      });
      // Backfill club_member_id to the canonical cr_member_id if we have it.
      if (canonical && !String(p.club_member_id || '').trim()) p.club_member_id = canonical;
    });
    audit_('player_update', 'player', existing.player_id, before, input);
    return getObjects_('Players').find(p => p.player_id === existing.player_id);
  }

  // New player: key on cr_member_id when known, else a generated id.
  const player_id = canonical || makeId_('player');
  const fullName = input.full_name || '';
  const parts = fullName.trim().split(/\s+/);
  const player = {
    player_id:      player_id,
    full_name:      fullName,
    first_name:     input.first_name || (parts.length ? parts[0] : ''),
    last_name:      input.last_name  || (parts.length > 1 ? parts.slice(1).join(' ') : ''),
    email:          email,
    phone:          input.phone || '',
    gender:         input.gender || '',
    dupr_id:        input.dupr_id || '',
    club_member_id: canonical || input.club_member_id || '',
    level:          input.level || '',
    active:         input.active === false ? false : true,
    notes:          input.notes || '',
    created_at:     nowStamp_(),
  };
  appendObjects_('Players', [player]);
  audit_('player_create', 'player', player_id, null, { email: email, full_name: fullName });
  return player;
}

/**
 * Diagnostic: list every Players row whose full_name is a "Guest <digits>"
 * placeholder and report whether CR_Attendance has a row that could upgrade it.
 * Run from the Apps Script editor: `diagnoseUnresolvedGuests()`. Logs to the
 * execution log and also returns the structured report.
 */
/**
 * Diagnostic: find every distinct player_id used in Games that doesn't resolve
 * to a real name — either ext_* with no CR_Attendance match, or any pid with
 * no Players row and no CR fallback. Logs to execution log + returns the list.
 */
function diagnoseUnresolvedGameRefs() {
  const players = getObjects_('Players');
  const playerById = {}; players.forEach(p => { playerById[p.player_id] = p; });
  const cr = getObjects_('CR_Attendance');
  const crByMn = {};
  cr.forEach(a => {
    const mn = String(a.member_number || '').trim();
    if (!mn) return;
    const fn = (String(a.first_name || '').trim() + ' ' + String(a.last_name || '').trim()).trim();
    if (!crByMn[mn]) crByMn[mn] = new Set();
    if (fn) crByMn[mn].add(fn);
  });

  const games = getObjects_('Games').filter(g => g.status === 'complete');
  const pidCounts = {};
  const pidSampleGame = {};
  games.forEach(g => {
    [g.t1_player_1_id, g.t1_player_2_id, g.t2_player_1_id, g.t2_player_2_id]
      .filter(Boolean).forEach(pid => {
        pidCounts[pid] = (pidCounts[pid] || 0) + 1;
        if (!pidSampleGame[pid]) pidSampleGame[pid] = g.game_id + ' (league ' + g.league_id + ', week ' + g.week_number + ')';
      });
  });

  const unresolved = [];
  Object.keys(pidCounts).forEach(pid => {
    const p = playerById[pid];
    if (p) {
      const fn = String(p.full_name || '').trim();
      if (fn && !/^Guest\s+\d+$/i.test(fn)) return;  // resolves OK via Players row
    }
    // No Players row OR Players row has placeholder name.
    let mn = '';
    if (String(pid).startsWith('ext_')) mn = String(pid).slice(4);
    else if (p && p.club_member_id) mn = String(p.club_member_id).trim();
    const crNames = mn && crByMn[mn] ? [...crByMn[mn]] : [];
    const realCr = crNames.filter(n => !/^Guest\s+\d+$/i.test(n));
    unresolved.push({
      player_id:      pid,
      occurrences:    pidCounts[pid],
      sample_game:    pidSampleGame[pid],
      has_player_row: !!p,
      player_fullname:p ? p.full_name : null,
      club_member_id: p ? p.club_member_id : null,
      extracted_mn:   mn || null,
      cr_attendance_names: crNames,
      would_resolve_to: realCr[0] || null,
    });
  });
  unresolved.sort((a, b) => b.occurrences - a.occurrences);
  Logger.log('Unresolved player refs in Games: ' + unresolved.length);
  unresolved.slice(0, 30).forEach(r => Logger.log(JSON.stringify(r)));
  return unresolved;
}

function diagnoseUnresolvedGuests() {
  const players = getObjects_('Players');
  const cr = getObjects_('CR_Attendance');
  const crByMn = {};   // mn → unique names seen
  const crSampleByMn = {};
  cr.forEach(a => {
    const mn = String(a.member_number || '').trim();
    if (!mn) return;
    const fn = (String(a.first_name || '').trim() + ' ' + String(a.last_name || '').trim()).trim();
    if (!crByMn[mn]) { crByMn[mn] = new Set(); crSampleByMn[mn] = a; }
    if (fn) crByMn[mn].add(fn);
  });
  const out = [];
  players.forEach(p => {
    const fn = String(p.full_name || '').trim();
    const m = fn.match(/^Guest\s+(\d+)$/i);
    if (!m) return;
    const fromName = m[1];
    const fromClubId = String(p.club_member_id || '').trim();
    const candidates = [fromClubId, fromName].filter(Boolean);
    let crHit = null;
    let crMatchedKey = null;
    for (const mid of candidates) {
      if (crByMn[mid]) {
        const realNames = [...crByMn[mid]].filter(n => !/^Guest\s+\d+$/i.test(n));
        if (realNames.length) { crHit = realNames; crMatchedKey = mid; break; }
      }
    }
    out.push({
      player_id:        p.player_id,
      full_name:        fn,
      club_member_id:   fromClubId || '(empty)',
      number_from_name: fromName,
      cr_attendance:    crByMn[fromName] ? [...crByMn[fromName]] : (crByMn[fromClubId] ? [...crByMn[fromClubId]] : []),
      cr_has_member_number: !!(crByMn[fromName] || crByMn[fromClubId]),
      would_resolve_to: crHit ? crHit[0] : null,
      matched_via:      crMatchedKey || null,
    });
  });
  Logger.log('Total guest-placeholder Players rows: ' + out.length);
  out.forEach(r => Logger.log(JSON.stringify(r)));
  return out;
}

/**
 * Resolve a Players row to its preferred display name. If the row was
 * auto-created with a "Guest <member_number>" placeholder name and we now
 * have a CR_Attendance match for that member_number, upgrade to the real
 * first-last name. crByMemberNum: { [member_number]: 'First Last' | { full_name } }.
 */
function displayPlayerName_(player, crByMemberNum) {
  if (!player) return '';
  const fn = String(player.full_name || '').trim();
  const ghostMatch = fn.match(/^Guest\s+(\d+)$/i);
  if (ghostMatch && crByMemberNum) {
    // Try club_member_id first, then the number embedded in the placeholder
    // name (covers guest Players rows that were created without club_member_id).
    const candidates = [String(player.club_member_id || '').trim(), ghostMatch[1]]
      .filter(Boolean);
    for (const mid of candidates) {
      const ext = crByMemberNum[mid];
      const real = (typeof ext === 'string') ? ext : (ext && ext.full_name);
      if (real && !/^Guest\s+\d+$/i.test(real)) return real;
    }
  }
  return fn;
}

/**
 * Find-or-create a guest player. Used when an external sub (CourtReserve
 * attendance with no roster match) gets paired into a session — they need
 * a Players row to be referenced by Substitutions, but they don't have an
 * email and shouldn't be deduped against rostered players.
 *
 * Dedup key: club_member_id when present, else lowercased full_name (only
 * matching existing rows where is_guest is truthy, so a guest can never
 * accidentally collide with a real roster entry).
 */
function upsertGuestPlayer_(input) {
  const fullName = String(input.full_name || '').trim();
  if (!fullName) throw new Error('Guest needs a full_name');
  const memId = String(input.member_number || input.club_member_id || '').trim();
  const nameKey = fullName.toLowerCase();

  const all = getObjects_('Players');

  // If this person is a real CourtReserve member, create/return a REAL player
  // keyed by cr_member_id — not a guest. This is the "everyone who attends is a
  // player" path: no guest flag, no ext_ placeholder, deterministic id.
  const canonical = canonicalMemberId_({ member_number: memId, club_member_id: memId });
  if (canonical) {
    const existingReal = all.find(p => String(p.player_id).trim() === canonical);
    if (existingReal) return existingReal;
    const m = crMemberRow_(canonical) || {};
    const f = String(m.first_name || '').trim();
    const l = String(m.last_name || '').trim();
    const realPlayer = {
      player_id:      canonical,
      full_name:      ((f + ' ' + l).trim()) || fullName,
      first_name:     f || (fullName.split(/\s+/)[0] || ''),
      last_name:      l || (fullName.split(/\s+/).slice(1).join(' ') || ''),
      email:          String(m.email || '').trim(),
      phone:          String(m.phone || '').trim(),
      gender:         String(m.gender || '').trim(),
      dupr_id:        '',
      club_member_id: canonical,
      level:          input.level || '',
      active:         true,
      notes:          'Auto-created from CourtReserve attendance',
      is_guest:       '',   // a real CR member, not a guest
      created_at:     nowStamp_(),
    };
    appendObjects_('Players', [realPlayer]);
    audit_('player_create', 'player', canonical, null, { full_name: realPlayer.full_name, source: 'cr_attendance' });
    return realPlayer;
  }

  // --- True non-member: keep the legacy guest path (generated id, is_guest). ---
  // Sheet booleans round-trip as either real booleans or the string 'TRUE'
  // (lowercase variants too if hand-edited) — see CLAUDE.md "quirks".
  const isGuestRow = p => {
    const v = p.is_guest;
    return v === true || v === 'TRUE' || v === 'true';
  };
  // 1) Try CR member_id match (most reliable).
  let guestMatch = memId
    ? all.find(p => isGuestRow(p) && String(p.club_member_id || '').trim() === memId)
    : null;
  // 2) Fall back to full-name match. Always run this (even when memId was
  //    provided) so a sub recorded without a member_id earlier in the season
  //    still matches when a later sub-in supplies one — otherwise we end up
  //    with duplicate guest Players rows for the same person.
  if (!guestMatch) {
    guestMatch = all.find(p => isGuestRow(p) &&
      String(p.full_name || '').trim().toLowerCase() === nameKey);
  }
  if (guestMatch) {
    // Backfill club_member_id on the existing row if we now know it.
    if (memId && !String(guestMatch.club_member_id || '').trim()) {
      updateWhere_('Players',
        p => p.player_id === guestMatch.player_id,
        p => { p.club_member_id = memId; });
      guestMatch.club_member_id = memId;
    }
    return guestMatch;
  }

  const player_id = makeId_('player');
  const parts = fullName.split(/\s+/);
  const player = {
    player_id:      player_id,
    full_name:      fullName,
    first_name:     parts[0] || '',
    last_name:      parts.length > 1 ? parts.slice(1).join(' ') : '',
    email:          '',
    phone:          '',
    gender:         '',
    dupr_id:        '',
    club_member_id: memId,
    level:          input.level || '',
    active:         true,
    notes:          'Guest sub — auto-created from CourtReserve attendance',
    is_guest:       true,
    created_at:     nowStamp_(),
  };
  appendObjects_('Players', [player]);
  audit_('player_create_guest', 'player', player_id, null,
    { full_name: fullName, member_number: memId });
  return player;
}

/**
 * One-off cleanup: find duplicate guest Players rows (same lower-cased
 * full_name), pick one keeper per name, repoint all Substitutions and other
 * references to the keeper, and mark the losers inactive with a note.
 *
 * Keeper priority: row with a club_member_id wins; tiebreak by earliest
 * created_at. Returns a report.
 */
function dedupeGuestPlayers_() {
  const all = getObjects_('Players');
  // "Guest-like" = any Player with no active roster entry. Captures both
  // is_guest=true rows from upsertGuestPlayer_ and unflagged rows created by
  // CR Team_Pairings materialization. Rostered competitors are skipped.
  const activeRosterPlayerIds = new Set(
    getObjects_('Rosters')
      .filter(r => r.status === 'active')
      .map(r => r.player_id)
  );
  const isEligible = p => !activeRosterPlayerIds.has(p.player_id);
  const byName = {};
  all.filter(isEligible).forEach(p => {
    const k = String(p.full_name || '').trim().toLowerCase();
    if (!k) return;
    if (!byName[k]) byName[k] = [];
    byName[k].push(p);
  });
  const merges = [];
  Object.keys(byName).forEach(k => {
    const rows = byName[k];
    if (rows.length < 2) return;
    rows.sort((a, b) => {
      const aHasMem = String(a.club_member_id || '').trim() ? 1 : 0;
      const bHasMem = String(b.club_member_id || '').trim() ? 1 : 0;
      if (aHasMem !== bHasMem) return bHasMem - aHasMem;
      return String(a.created_at || '').localeCompare(String(b.created_at || ''));
    });
    const keeper = rows[0];
    rows.slice(1).forEach(loser => {
      merges.push({ keeper_id: keeper.player_id, loser_id: loser.player_id, name: keeper.full_name });
    });
  });

  if (!merges.length) return { duplicates_found: 0, merges: [] };

  const loserToKeeper = {};
  merges.forEach(m => { loserToKeeper[m.loser_id] = m.keeper_id; });

  // Repoint Substitutions: absent_player_id + substitute_player_id.
  updateWhere_('Substitutions',
    s => !!(loserToKeeper[s.absent_player_id] || loserToKeeper[s.substitute_player_id]),
    s => {
      if (loserToKeeper[s.absent_player_id]) s.absent_player_id = loserToKeeper[s.absent_player_id];
      if (loserToKeeper[s.substitute_player_id]) s.substitute_player_id = loserToKeeper[s.substitute_player_id];
    });

  // Repoint Games: every t*_player_*_id slot.
  const slots = ['t1_player_1_id', 't1_player_2_id', 't2_player_1_id', 't2_player_2_id'];
  updateWhere_('Games',
    g => slots.some(k => loserToKeeper[g[k]]),
    g => { slots.forEach(k => { if (loserToKeeper[g[k]]) g[k] = loserToKeeper[g[k]]; }); });

  // Repoint Teams (rare for guests, but be safe).
  updateWhere_('Teams',
    t => !!(loserToKeeper[t.player_1_id] || loserToKeeper[t.player_2_id]),
    t => {
      if (loserToKeeper[t.player_1_id]) t.player_1_id = loserToKeeper[t.player_1_id];
      if (loserToKeeper[t.player_2_id]) t.player_2_id = loserToKeeper[t.player_2_id];
    });

  // Repoint Rosters.
  updateWhere_('Rosters',
    r => !!loserToKeeper[r.player_id],
    r => { r.player_id = loserToKeeper[r.player_id]; });

  // Mark loser Players rows inactive and note the merge.
  updateWhere_('Players',
    p => !!loserToKeeper[p.player_id],
    p => {
      p.active = false;
      p.notes = (p.notes ? p.notes + ' | ' : '') + 'merged into ' + loserToKeeper[p.player_id];
    });

  merges.forEach(m => {
    audit_('player_merge_guest', 'player', m.loser_id, null,
      { merged_into: m.keeper_id, name: m.name });
  });

  return { duplicates_found: merges.length, merges };
}

function dedupeGuestPlayersRun() { return dedupeGuestPlayers_(); }

/**
 * Promote a CourtReserve sub's historical games to their real Players row.
 *
 * Ladder CR subs are recorded in Games / Session_Groups / Session_Game_Overrides
 * with synthetic `ext_<member_number>` IDs — there's no Players row, so the
 * standings recompute (which only credits active-roster player_ids) skips them.
 * When that same person later registers for the full session,
 * syncLadderRosterFromAttendance_ creates a real Players row keyed by
 * club_member_id = member_number and rosters them — but their past ext_ games
 * stay orphaned under the old synthetic ID.
 *
 * This rewrites every `ext_<member_number>` reference to the real player_id so
 * those games credit the now-rostered player in season standings. Games and
 * Session_Groups are repointed together, so the scheduled-four check in
 * computeLadderStandings_ keeps matching. Bumps the version of every affected
 * league so the standings cache busts.
 *
 * @param {string}  member_number     CR member number (the digits after `ext_`);
 *                                     it's the "Club member ID" on her record.
 * @param {string}  [keeper_player_id] real Players.player_id to repoint to.
 *                                     Defaults to the Players row whose
 *                                     club_member_id === member_number.
 * @param {boolean} [dryRun]          if true, return the counts without writing.
 * @returns {{ ext_id, keeper_player_id, keeper_name, games, session_groups,
 *             overrides, leagues_bumped, dry_run }}
 */
function promoteExtSubToPlayer_(member_number, keeper_player_id, dryRun) {
  const mn = String(member_number || '').trim();
  if (!mn) throw new Error('member_number required');
  const extId = 'ext_' + mn;

  const players = getObjects_('Players');

  // Resolve the keeper (real) player.
  let keeper = String(keeper_player_id || '').trim();
  let keeperRow;
  if (keeper) {
    keeperRow = players.find(p => p.player_id === keeper);
    if (!keeperRow) throw new Error('keeper_player_id not found: ' + keeper);
  } else {
    keeperRow = players.find(p =>
      String(p.club_member_id || '').trim() === mn &&
      !String(p.player_id).startsWith('ext_'));
    if (!keeperRow) {
      throw new Error('No real Players row with club_member_id ' + mn +
        '. Run the roster sync first (Admin/League → "Sync roster from attendance"), ' +
        'or pass keeper_player_id explicitly.');
    }
    keeper = keeperRow.player_id;
  }
  if (keeper === extId) throw new Error('keeper equals the ext id — nothing to repoint');

  const SLOTS = ['t1_player_1_id', 't1_player_2_id', 't2_player_1_id', 't2_player_2_id'];
  const leaguesTouched = {};

  let gameHits = 0;
  getObjects_('Games').forEach(g => {
    if (SLOTS.some(k => g[k] === extId)) { gameHits++; if (g.league_id) leaguesTouched[g.league_id] = true; }
  });

  let sgHits = 0;
  getObjects_('Session_Groups').forEach(r => {
    if (r.player_id === extId || r.original_player_id === extId) {
      sgHits++; if (r.league_id) leaguesTouched[r.league_id] = true;
    }
  });

  let ovRows = [];
  try { ovRows = getObjects_('Session_Game_Overrides'); } catch (_) {}
  let ovHits = 0;
  ovRows.forEach(r => {
    if (r.player_id === extId || r.original_player_id === extId) {
      ovHits++; if (r.league_id) leaguesTouched[r.league_id] = true;
    }
  });

  const report = {
    ext_id:           extId,
    keeper_player_id: keeper,
    keeper_name:      keeperRow.full_name || '',
    games:            gameHits,
    session_groups:   sgHits,
    overrides:        ovHits,
    leagues_bumped:   Object.keys(leaguesTouched),
    dry_run:          !!dryRun,
  };
  if (dryRun) return report;

  if (gameHits) {
    updateWhere_('Games',
      g => SLOTS.some(k => g[k] === extId),
      g => { SLOTS.forEach(k => { if (g[k] === extId) g[k] = keeper; }); });
  }
  if (sgHits) {
    updateWhere_('Session_Groups',
      r => r.player_id === extId || r.original_player_id === extId,
      r => {
        if (r.player_id === extId) r.player_id = keeper;
        if (r.original_player_id === extId) r.original_player_id = keeper;
      });
  }
  if (ovHits) {
    updateWhere_('Session_Game_Overrides',
      r => r.player_id === extId || r.original_player_id === extId,
      r => {
        if (r.player_id === extId) r.player_id = keeper;
        if (r.original_player_id === extId) r.original_player_id = keeper;
      });
  }
  Object.keys(leaguesTouched).forEach(lid => bumpLeagueVersion_(lid));
  audit_('promote_ext_sub', 'player', keeper, null, report);
  return report;
}

/**
 * One-off runner for promoteExtSubToPlayer_ (the Run dropdown can't pass args).
 * Edit MEMBER_NUMBER, run once to preview the counts, then set DRY_RUN = false
 * and run again to actually repoint.
 */
function promoteExtSubRun() {
  const MEMBER_NUMBER = '';    // ← her CourtReserve member # ("Club member ID" on her record)
  const DRY_RUN       = true;  // ← true = preview only; false = commit the repoint
  if (!MEMBER_NUMBER) throw new Error('Set MEMBER_NUMBER first');
  const r = promoteExtSubToPlayer_(MEMBER_NUMBER, null, DRY_RUN);
  Logger.log(JSON.stringify(r, null, 2));
  return r;
}

/**
 * Name-based convenience wrapper for promoteExtSubToPlayer_ — use when you
 * don't have the CR member number handy.
 *
 * Finds the real (non-ext) Players row by exact full_name, gathers every CR
 * member number tied to that name (the record's own club_member_id plus any
 * CR_Attendance rows matching the name), and repoints each matching
 * `ext_<member_number>` to that real player_id.
 *
 * @param {string}  full_name
 * @param {boolean} [dryRun]  true = report counts without writing
 * @returns {{ keeper_player_id, keeper_name, member_numbers, results }}
 */
function linkSubGamesByName_(full_name, dryRun) {
  const target = String(full_name || '').trim().toLowerCase();
  if (!target) throw new Error('full_name required');

  const players = getObjects_('Players');
  const candidates = players.filter(p =>
    String(p.full_name || '').trim().toLowerCase() === target &&
    !String(p.player_id).startsWith('ext_'));
  if (!candidates.length) throw new Error('No real Players row named "' + full_name + '"');

  // Prefer an active-rostered candidate, then one that has a club_member_id.
  const activeRoster = {};
  getObjects_('Rosters').forEach(r => { if (r.status === 'active') activeRoster[r.player_id] = true; });
  candidates.sort((a, b) => {
    const ar = activeRoster[a.player_id] ? 1 : 0, br = activeRoster[b.player_id] ? 1 : 0;
    if (ar !== br) return br - ar;
    const am = String(a.club_member_id || '').trim() ? 1 : 0;
    const bm = String(b.club_member_id || '').trim() ? 1 : 0;
    return bm - am;
  });
  if (candidates.length > 1) {
    Logger.log('Note: ' + candidates.length + ' players named "' + full_name +
      '"; using ' + candidates[0].player_id + '. Pass an explicit keeper if that is wrong.');
  }
  const keeper = candidates[0];

  // Member numbers: the keeper's own, plus any CR_Attendance rows by name.
  const mns = {};
  const km = String(keeper.club_member_id || '').trim();
  if (km) mns[km] = true;
  getObjects_('CR_Attendance').forEach(a => {
    const nm = (String(a.first_name || '').trim() + ' ' + String(a.last_name || '').trim())
      .trim().toLowerCase();
    if (nm === target) {
      const m = String(a.member_number || '').trim();
      if (m) mns[m] = true;
    }
  });
  const member_numbers = Object.keys(mns);
  if (!member_numbers.length) {
    throw new Error('No CR member number found for "' + full_name + '" (no club_member_id ' +
      'on the record and no CR_Attendance match). Set her Club member ID, or call ' +
      'promoteExtSubToPlayer_(member_number, keeper_player_id) directly.');
  }

  const results = member_numbers.map(mn =>
    promoteExtSubToPlayer_(mn, keeper.player_id, dryRun));

  const out = {
    keeper_player_id: keeper.player_id,
    keeper_name:      keeper.full_name || full_name,
    member_numbers:   member_numbers,
    results:          results,
  };
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

/**
 * One-off runner: edit FULL_NAME, run to preview, then set DRY_RUN = false and
 * run again to commit.
 */
function linkSubGamesByNameRun() {
  const FULL_NAME = 'Marisol Bordo';
  const DRY_RUN   = true;   // ← true = preview only; false = commit the repoint
  return linkSubGamesByName_(FULL_NAME, DRY_RUN);
}

function findPlayerByEmail_(email) {
  if (!email) return null;
  const e = String(email).toLowerCase().trim();
  return getObjects_('Players').find(p => (p.email || '').toLowerCase() === e) || null;
}

function findPlayerByName_(fullName) {
  if (!fullName) return null;
  const n = String(fullName).toLowerCase().trim();
  return getObjects_('Players').find(p => (p.full_name || '').toLowerCase().trim() === n) || null;
}

/**
 * Add a player to a league's roster. Idempotent — returns the existing
 * roster row if already present.
 */
function addToRoster_(league_id, player_id, opts) {
  if (!league_id || !player_id) throw new Error('league_id and player_id required');
  opts = opts || {};
  const existing = getObjects_('Rosters')
    .find(r => r.league_id === league_id && r.player_id === player_id);
  if (existing) return existing;

  const row = {
    roster_id: makeId_('roster'),
    league_id: league_id,
    player_id: player_id,
    team_id:   opts.team_id || '',
    level:     opts.level || '',
    status:    opts.status || 'active',
    added_at:  nowStamp_(),
    added_by:  activeUserEmail_(),
  };
  appendObjects_('Rosters', [row]);
  cacheBust_('league:' + league_id + ':full');
  audit_('roster_add', 'roster', row.roster_id, null, { league_id, player_id });
  return row;
}

function removeFromRoster_(league_id, player_id) {
  const before = getObjects_('Rosters')
    .find(r => r.league_id === league_id && r.player_id === player_id);
  if (!before) return false;
  updateWhere_('Rosters',
    r => r.league_id === league_id && r.player_id === player_id,
    r => { r.status = 'inactive'; });
  cacheBust_('league:' + league_id + ':full');
  audit_('roster_remove', 'roster', before.roster_id, before.status, 'inactive');
  return true;
}

function listRoster_(league_id, opts) {
  opts = opts || {};
  const rosters = getObjects_('Rosters').filter(r => r.league_id === league_id);
  const filtered = opts.includeInactive ? rosters : rosters.filter(r => r.status === 'active');
  const players = getObjects_('Players');
  const byId = {};
  players.forEach(p => { byId[p.player_id] = p; });
  return filtered.map(r => Object.assign({}, byId[r.player_id] || {}, {
    roster_id: r.roster_id,
    league_id: r.league_id,
    team_id:   r.team_id,
    roster_status: r.status,
    roster_level:  r.level,
  }));
}

/** Partner-only: create a 2-player team in a league. */
function createTeam_(league_id, team_name, player_1_id, player_2_id) {
  if (!league_id || !team_name) throw new Error('league_id and team_name required');
  if (!player_1_id || !player_2_id) throw new Error('two player_ids required');
  const team_id = makeId_('team');
  appendObjects_('Teams', [{
    team_id: team_id,
    league_id: league_id,
    team_name: team_name,
    player_1_id: player_1_id,
    player_2_id: player_2_id,
    created_at: nowStamp_(),
  }]);
  // Auto-roster both players to this team.
  addToRoster_(league_id, player_1_id, { team_id });
  addToRoster_(league_id, player_2_id, { team_id });
  cacheBust_('league:' + league_id + ':full');
  audit_('team_create', 'team', team_id, null, { league_id, team_name, player_1_id, player_2_id });
  return team_id;
}

function listTeams_(league_id) {
  return getObjects_('Teams').filter(t => t.league_id === league_id);
}

/**
 * Candidate players for a partner per-game substitution: everyone associated
 * with the league as a roster member OR a recorded substitute — i.e. anyone
 * who could be playing that night. Used by the per-game sub picker so the
 * operator isn't limited to the season roster.
 *
 * @returns {Array<{player_id, full_name, source}>}  source: 'roster' | 'sub'
 */
function listPartnerSubCandidates_(league_id) {
  const out = {};
  const playerById = {};
  getObjects_('Players').forEach(p => { playerById[p.player_id] = p; });

  listRoster_(league_id).forEach(p => {
    if (!p.player_id) return;
    out[p.player_id] = {
      player_id: p.player_id,
      full_name: p.full_name || (playerById[p.player_id] && playerById[p.player_id].full_name) || '',
      source:    'roster',
    };
  });
  getObjects_('Substitutions').forEach(s => {
    if (s.league_id !== league_id) return;
    const pid = s.substitute_player_id;
    if (!pid || out[pid]) return;
    out[pid] = {
      player_id: pid,
      full_name: s.substitute_player_name || (playerById[pid] && playerById[pid].full_name) || '',
      source:    'sub',
    };
  });
  return Object.keys(out).map(k => out[k])
    .sort((a, b) => String(a.full_name).localeCompare(String(b.full_name)));
}

/**
 * Rename a team. Idempotent. Audited.
 */
function renameTeam_(team_id, new_name) {
  const name = String(new_name || '').trim();
  if (!name) throw new Error('team_name cannot be blank');
  const before = getObjects_('Teams').find(t => t.team_id === team_id);
  if (!before) throw new Error('Team not found: ' + team_id);
  if (before.team_name === name) return before;
  updateWhere_('Teams', t => t.team_id === team_id, t => { t.team_name = name; });
  cacheBust_('league:' + before.league_id + ':full');
  audit_('team_rename', 'team', team_id, before.team_name, name);
  return getObjects_('Teams').find(t => t.team_id === team_id);
}

/**
 * Replace ONE member of a partner team without changing the team's identity
 * (team_id), so its games, record, standings and schedule slots are all
 * preserved — and remove a duplicate team accidentally created for the swap.
 *
 * Partner teams have two possible sources; this handles both, because a direct
 * Teams edit is silently reverted for CourtReserve-backed teams:
 *   - pairing-backed (Teams.team_id === Team_Pairings.pairing_id):
 *     materializePairingsToTeams_ re-syncs Teams from the pairing on every
 *     partner standings recompute. So we edit the pairing's member_id when the
 *     new player has a club_member_id; otherwise we detach the pairing (the
 *     team becomes manually-managed) so the Teams edit sticks.
 *   - manual (no pairing): edit the Teams row directly.
 *
 * @param {Object} input
 *   keeper_team_id       team to KEEP (the one with the record)
 *   departing_player_id  member of the keeper team being replaced
 *   new_player_id        replacement (a Players row must already exist)
 *   dupe_team_id         (optional) duplicate team to delete
 *   dryRun               report the plan without writing anything
 */
function replacePartnerTeammate_(input) {
  const dryRun = !!input.dryRun;
  const keeper = getObjects_('Teams').find(t => t.team_id === input.keeper_team_id);
  if (!keeper) throw new Error('keeper_team_id not found: ' + input.keeper_team_id);
  const lid = keeper.league_id;
  const dep = String(input.departing_player_id || '');
  const np  = String(input.new_player_id || '');
  if (!dep || !np) throw new Error('departing_player_id and new_player_id required');
  if (keeper.player_1_id !== dep && keeper.player_2_id !== dep) {
    throw new Error('Departing player is not on the keeper team');
  }
  const players = getObjects_('Players');
  const newP = players.find(p => p.player_id === np);
  if (!newP) throw new Error('new_player_id not found: ' + np);
  const nameById = {}; players.forEach(p => { nameById[p.player_id] = p.full_name || ''; });

  const slot = keeper.player_1_id === dep ? 'player_1_id' : 'player_2_id';
  const pairing = getObjects_('Team_Pairings').find(p => p.pairing_id === keeper.team_id);
  const newMember = String(newP.club_member_id || '').trim();
  const strategy = !pairing ? 'edit_teams' : (newMember ? 'edit_pairing' : 'detach_pairing');

  const plan = {
    league_id:            lid,
    keeper_team_id:       keeper.team_id,
    keeper_team_name:     keeper.team_name,
    slot:                 slot,
    departing:            { id: dep, name: nameById[dep] || '(?)' },
    incoming:             { id: np, name: newP.full_name, club_member_id: newMember || null },
    keeper_pairing_backed: !!pairing,
    strategy:             strategy,   // edit_teams | edit_pairing | detach_pairing
    dupe_team_id:         input.dupe_team_id || null,
    roster:               'deactivate departing, add incoming to keeper, drop dupe roster rows',
    dry_run:              dryRun,
  };
  if (dryRun) { Logger.log(JSON.stringify(plan, null, 2)); return plan; }

  // 1. Remove the duplicate first (so the new player's roster row is freed).
  if (input.dupe_team_id && input.dupe_team_id !== keeper.team_id) {
    const dupeId = input.dupe_team_id;
    const gslots = ['t1_team_id', 't2_team_id'];
    updateWhere_('Games',
      g => g.t1_team_id === dupeId || g.t2_team_id === dupeId,
      g => { gslots.forEach(k => { if (g[k] === dupeId) g[k] = keeper.team_id; }); });
    overwriteObjects_('Teams',         getObjects_('Teams').filter(t => t.team_id !== dupeId));
    overwriteObjects_('Team_Pairings', getObjects_('Team_Pairings').filter(p => p.pairing_id !== dupeId));
    overwriteObjects_('Rosters',       getObjects_('Rosters').filter(r => r.team_id !== dupeId));
  }

  // 2. Swap the player at the source.
  if (strategy === 'edit_pairing') {
    const pslot = slot === 'player_1_id' ? 'p1_member_id' : 'p2_member_id';
    updateWhere_('Team_Pairings', p => p.pairing_id === keeper.team_id, p => { p[pslot] = newMember; });
  } else if (strategy === 'detach_pairing') {
    overwriteObjects_('Team_Pairings', getObjects_('Team_Pairings').filter(p => p.pairing_id !== keeper.team_id));
  }
  // Always update the Teams row (immediate; covers manual + detached).
  updateWhere_('Teams', t => t.team_id === keeper.team_id, t => { t[slot] = np; });

  // 3. Roster: departing out, incoming onto the keeper team.
  removeFromRoster_(lid, dep);
  addToRoster_(lid, np, { team_id: keeper.team_id });

  bumpLeagueVersion_(lid);
  cacheBust_('league:' + lid + ':full');
  audit_('partner_teammate_replace', 'team', keeper.team_id, null, plan);
  Logger.log(JSON.stringify(plan, null, 2));
  return plan;
}

/**
 * One-off runner for the Intermediate Mixed "Volley Llamas" duplicate.
 * Resolves the departing/incoming players structurally (the shared player is the
 * one who stays), so it can't pick the wrong person. Run with DRY_RUN = true to
 * preview, then set it to false to commit.
 */
function fixVolleyLlamasRun() {
  const KEEPER  = 'TMOS7UCVM34';   // Jim Gop + Heather Gop — 14-10, the real team
  const DUPE    = 'TMPYHVRBUVG';   // Vanessa DiVita + Jim Gop — 0-0, created by mistake
  const DRY_RUN = false;           // flip to false to commit

  const teams  = getObjects_('Teams');
  const keeper = teams.find(t => t.team_id === KEEPER);
  const dupe   = teams.find(t => t.team_id === DUPE);
  if (!keeper || !dupe) throw new Error('keeper or dupe team not found — verify the IDs');
  const kP = [keeper.player_1_id, keeper.player_2_id].filter(Boolean);
  const dP = [dupe.player_1_id,   dupe.player_2_id].filter(Boolean);
  const retained = kP.find(id => dP.indexOf(id) !== -1);   // Jim Gop (on both)
  if (!retained) throw new Error('No shared player between the two teams — aborting');
  const departing = kP.find(id => id !== retained);        // Heather Gop
  const incoming  = dP.find(id => id !== retained);        // Vanessa DiVita
  if (!departing || !incoming) throw new Error('Could not resolve departing/incoming players');

  return replacePartnerTeammate_({
    keeper_team_id:      KEEPER,
    departing_player_id: departing,
    new_player_id:       incoming,
    dupe_team_id:        DUPE,
    dryRun:              DRY_RUN,
  });
}

/**
 * Full reconcile for a permanent partner replacement done via the "new team"
 * workaround. Consolidates to ONE team (keeps the record), rewrites per-game
 * snapshots so the right person is credited (DUPR + results, killing the bogus
 * `*` sub marks), deletes the duplicate, and reconciles the CR pairing so
 * materializePairingsToTeams_ won't undo it.
 *
 * @param {Object} input
 *   keeper_team_id, dupe_team_id?, departing_player_id, new_player_id,
 *   snapshot_from_week  (rewrite keeper snapshots departing->new for week >= this;
 *                        1 = all weeks; 2 = keep week 1 as the departing player),
 *   dryRun
 */
function reconcilePartnerReplacement_(input) {
  const dryRun = !!input.dryRun;
  const keeper = getObjects_('Teams').find(t => t.team_id === input.keeper_team_id);
  if (!keeper) throw new Error('keeper_team_id not found: ' + input.keeper_team_id);
  const lid = keeper.league_id;
  const dep = String(input.departing_player_id || '');
  const np  = String(input.new_player_id || '');
  if (!dep || !np) throw new Error('departing_player_id and new_player_id required');
  const players = getObjects_('Players');
  const pById = {}; players.forEach(p => { pById[p.player_id] = p; });
  if (!pById[np]) throw new Error('new_player_id not found: ' + np);
  const nm = id => (pById[id] && pById[id].full_name) || id || '(empty)';
  const fromWeek = Number(input.snapshot_from_week || 1);

  const onKeeper   = keeper.player_1_id === dep || keeper.player_2_id === dep;
  const keeperSlot = keeper.player_1_id === dep ? 'player_1_id'
                   : (keeper.player_2_id === dep ? 'player_2_id' : null);
  const keeperPairing = getObjects_('Team_Pairings').find(p => p.pairing_id === keeper.team_id);
  const newMember = String(pById[np].club_member_id || '').trim();
  const keeperStrategy = !onKeeper ? 'team_already_swapped'
    : (!keeperPairing ? 'edit_teams' : (newMember ? 'edit_pairing' : 'detach_pairing'));

  // Snapshot rewrite plan: keeper games at week >= fromWeek where a keeper slot holds `dep`.
  const inKeeperSlot = (g) => (g.t1_team_id === keeper.team_id && (g.t1_player_1_id === dep || g.t1_player_2_id === dep)) ||
                              (g.t2_team_id === keeper.team_id && (g.t2_player_1_id === dep || g.t2_player_2_id === dep));
  const toRewrite = getObjects_('Games').filter(g =>
    g.league_id === lid && g.status !== 'voided' && Number(g.week_number) >= fromWeek && inKeeperSlot(g));
  const snapWeeks = {};
  toRewrite.forEach(g => { snapWeeks[g.week_number] = (snapWeeks[g.week_number] || 0) + 1; });

  const dupe = input.dupe_team_id ? getObjects_('Teams').find(t => t.team_id === input.dupe_team_id) : null;
  const dupeGames = input.dupe_team_id
    ? getObjects_('Games').filter(g => g.t1_team_id === input.dupe_team_id || g.t2_team_id === input.dupe_team_id).length : 0;

  const plan = {
    league_id: lid,
    keeper: { team_id: keeper.team_id, name: keeper.team_name, current: [nm(keeper.player_1_id), nm(keeper.player_2_id)] },
    departing: { id: dep, name: nm(dep) },
    incoming:  { id: np,  name: nm(np), club_member_id: newMember || null },
    keeper_slot: keeperSlot,
    keeper_strategy: keeperStrategy,
    keeper_pairing_backed: !!keeperPairing,
    snapshot_from_week: fromWeek,
    snapshot_games_to_rewrite: toRewrite.length,
    snapshot_weeks: snapWeeks,
    dupe: input.dupe_team_id ? { team_id: input.dupe_team_id, name: dupe && dupe.team_name, games: dupeGames } : null,
    dry_run: dryRun,
    warnings: [],
  };
  if (keeperStrategy === 'detach_pairing') plan.warnings.push('Keeper is CR-paired and incoming has no club_member_id → its CR pairing is removed (team becomes manually managed).');
  if (dupeGames) plan.warnings.push('Dupe has ' + dupeGames + ' games — they will be repointed to the keeper.');
  if (dryRun) { Logger.log(JSON.stringify(plan, null, 2)); return plan; }

  // 1. Remove the duplicate (repoint any games, drop Teams/pairing/roster rows).
  if (input.dupe_team_id && input.dupe_team_id !== keeper.team_id) {
    const dId = input.dupe_team_id;
    updateWhere_('Games', g => g.t1_team_id === dId || g.t2_team_id === dId, g => {
      if (g.t1_team_id === dId) g.t1_team_id = keeper.team_id;
      if (g.t2_team_id === dId) g.t2_team_id = keeper.team_id;
    });
    overwriteObjects_('Teams',         getObjects_('Teams').filter(t => t.team_id !== dId));
    overwriteObjects_('Team_Pairings', getObjects_('Team_Pairings').filter(p => p.pairing_id !== dId));
    overwriteObjects_('Rosters',       getObjects_('Rosters').filter(r => r.team_id !== dId));
  }

  // 2. Swap the player on the keeper (at the source), if still present there.
  if (onKeeper) {
    if (keeperStrategy === 'edit_pairing') {
      const pslot = keeperSlot === 'player_1_id' ? 'p1_member_id' : 'p2_member_id';
      updateWhere_('Team_Pairings', p => p.pairing_id === keeper.team_id, p => { p[pslot] = newMember; });
    } else if (keeperStrategy === 'detach_pairing') {
      overwriteObjects_('Team_Pairings', getObjects_('Team_Pairings').filter(p => p.pairing_id !== keeper.team_id));
    }
    updateWhere_('Teams', t => t.team_id === keeper.team_id, t => { t[keeperSlot] = np; });
    removeFromRoster_(lid, dep);
    addToRoster_(lid, np, { team_id: keeper.team_id });
  }

  // 3. Rewrite game snapshots departing->new on the keeper, week >= fromWeek.
  let rewritten = 0;
  updateWhere_('Games',
    g => g.league_id === lid && g.status !== 'voided' && Number(g.week_number) >= fromWeek && inKeeperSlot(g),
    g => {
      if (g.t1_team_id === keeper.team_id) { if (g.t1_player_1_id === dep) g.t1_player_1_id = np; if (g.t1_player_2_id === dep) g.t1_player_2_id = np; }
      if (g.t2_team_id === keeper.team_id) { if (g.t2_player_1_id === dep) g.t2_player_1_id = np; if (g.t2_player_2_id === dep) g.t2_player_2_id = np; }
      g.updated_at = nowStamp_();
      rewritten++;
    });

  bumpLeagueVersion_(lid);
  cacheBust_('league:' + lid + ':full');
  plan.snapshot_games_rewritten = rewritten;
  audit_('partner_replacement_reconcile', 'team', keeper.team_id, null, plan);
  Logger.log(JSON.stringify(plan, null, 2));
  return plan;
}

/** Soft Hands (Intermediate Mixed): Marissa replaced Emily before week 1. */
function fixSoftHandsRun() {
  const KEEPER = 'TMOT0YE7CY7';   // Satish + Emily Nolan, 12-10 (the record)
  const DUPE   = 'TMPJX5WQX0H';   // Marissa + Satish, 0-0 (the workaround team)
  const FROM_WEEK = 1;            // Emily never played → Marissa for every week
  const DRY_RUN   = false;        // flip to false to commit

  const teams = getObjects_('Teams');
  const k = teams.find(t => t.team_id === KEEPER), d = teams.find(t => t.team_id === DUPE);
  if (!k || !d) throw new Error('keeper or dupe team not found');
  const kP = [k.player_1_id, k.player_2_id].filter(Boolean), dP = [d.player_1_id, d.player_2_id].filter(Boolean);
  const retained  = kP.find(id => dP.indexOf(id) !== -1);   // Satish (shared)
  const departing = kP.find(id => id !== retained);          // Emily
  const incoming  = dP.find(id => id !== retained);          // Marissa
  if (!retained || !departing || !incoming) throw new Error('Could not resolve players — verify the team IDs');
  return reconcilePartnerReplacement_({
    keeper_team_id: KEEPER, dupe_team_id: DUPE,
    departing_player_id: departing, new_player_id: incoming,
    snapshot_from_week: FROM_WEEK, dryRun: DRY_RUN,
  });
}

/** Volley Llamas (Intermediate Mixed): snapshots only — team + dupe already fixed.
 *  Vanessa replaced Heather before week 2. FROM_WEEK=2 keeps week 1 as Heather
 *  (she played it); set FROM_WEEK=1 to rewrite every week to Vanessa. */
function fixVolleyLlamasSnapshotsRun() {
  const KEEPER    = 'TMOS7UCVM34';   // Jim + Vanessa (already swapped)
  const FROM_WEEK = 2;
  const DRY_RUN   = false;           // flip to false to commit

  const k = getObjects_('Teams').find(t => t.team_id === KEEPER);
  if (!k) throw new Error('keeper not found');
  const current = new Set([k.player_1_id, k.player_2_id].filter(Boolean));
  const snap = new Set();
  getObjects_('Games').forEach(g => {
    if (g.status === 'voided') return;
    if (g.t1_team_id === KEEPER) [g.t1_player_1_id, g.t1_player_2_id].forEach(p => p && snap.add(p));
    if (g.t2_team_id === KEEPER) [g.t2_player_1_id, g.t2_player_2_id].forEach(p => p && snap.add(p));
  });
  const departing = Array.from(snap).find(p => !current.has(p));   // Heather (in old snapshots, not current)
  const incoming  = Array.from(current).find(p => !snap.has(p));    // Vanessa (current, not in old snapshots)
  if (!departing || !incoming) throw new Error('Could not resolve players (snap=' + Array.from(snap) + ' current=' + Array.from(current) + ')');
  return reconcilePartnerReplacement_({
    keeper_team_id: KEEPER,
    departing_player_id: departing, new_player_id: incoming,
    snapshot_from_week: FROM_WEEK, dryRun: DRY_RUN,
  });
}

/**
 * Apply a one-week partner SUB to the recorded game snapshots: rewrite the
 * absent player's snapshot → the sub, ONLY for the given week. Unlike a
 * permanent replacement, this does NOT touch the team's current players, the
 * roster, or the pairing — the absent regular stays on the team; the sub is
 * only credited for the games they actually played that week (for DUPR + the
 * Match Results page). Standings are by team_id, so they don't change.
 *
 * @param {string} league_id
 * @param {number} week_number
 * @param {string} absent_player_id   the regular who was out
 * @param {string} sub_player_id      who actually played
 * @param {boolean} dryRun
 * @param {Object} ctx                optional {league_name, source} for the log
 */
function applyPartnerGameSub_(league_id, week_number, absent_player_id, sub_player_id, dryRun, ctx) {
  if (!absent_player_id || !sub_player_id) throw new Error('absent and sub player_id required');
  if (absent_player_id === sub_player_id) throw new Error('absent and sub are the same player');
  const wk = Number(week_number);
  const SLOTS = ['t1_player_1_id', 't1_player_2_id', 't2_player_1_id', 't2_player_2_id'];
  const pById = {}; getObjects_('Players').forEach(p => { pById[p.player_id] = p; });
  const teamById = {}; getObjects_('Teams').forEach(t => { teamById[t.team_id] = t; });
  const nm = id => (pById[id] && pById[id].full_name) || id;
  const match = g => g.league_id === league_id && g.status !== 'voided' &&
    Number(g.week_number) === wk && SLOTS.some(k => g[k] === absent_player_id);

  const games = getObjects_('Games').filter(match);
  const teams = {};
  games.forEach(g => {
    const tid = (g.t1_player_1_id === absent_player_id || g.t1_player_2_id === absent_player_id)
      ? g.t1_team_id : g.t2_team_id;
    teams[tid] = (teams[tid] || 0) + 1;
  });

  const plan = {
    league_id, league_name: ctx && ctx.league_name, week: wk,
    absent: { id: absent_player_id, name: nm(absent_player_id) },
    sub:    { id: sub_player_id,    name: nm(sub_player_id) },
    id_source: ctx && ctx.source,
    games_to_rewrite: games.length,
    teams_affected: Object.keys(teams).map(tid => ({ team: (teamById[tid] || {}).team_name || tid, games: teams[tid] })),
    dry_run: !!dryRun,
  };
  if (dryRun) { Logger.log(JSON.stringify(plan, null, 2)); return plan; }

  let n = 0;
  updateWhere_('Games', match, g => {
    SLOTS.forEach(k => { if (g[k] === absent_player_id) g[k] = sub_player_id; });
    g.updated_at = nowStamp_();
    n++;
  });
  bumpLeagueVersion_(league_id);
  cacheBust_('league:' + league_id + ':full');
  plan.games_rewritten = n;
  audit_('partner_game_sub_applied', 'league', league_id, null, plan);
  Logger.log(JSON.stringify(plan, null, 2));
  return plan;
}

/**
 * Inverse of applyPartnerGameSub_: for that week's games on the absent player's
 * own team, swap the sub back to the absent regular. Used when a paired sub is
 * unpaired (voidSubstitution_). Team-scoped via the absent player's team (which
 * pairing never changes), so a sub who legitimately played on a DIFFERENT team
 * that week is left untouched.
 */
function revertPartnerGameSub_(league_id, week_number, absent_player_id, sub_player_id) {
  const wk = Number(week_number);
  const teamOf = {};
  getObjects_('Teams').forEach(t => {
    if (t.player_1_id) teamOf[t.player_1_id] = t.team_id;
    if (t.player_2_id) teamOf[t.player_2_id] = t.team_id;
  });
  const tid = teamOf[absent_player_id];   // absent regular's team — unchanged by pairing
  const match = g => g.league_id === league_id && g.status !== 'voided' && Number(g.week_number) === wk &&
    (tid
      ? ((g.t1_team_id === tid && (g.t1_player_1_id === sub_player_id || g.t1_player_2_id === sub_player_id)) ||
         (g.t2_team_id === tid && (g.t2_player_1_id === sub_player_id || g.t2_player_2_id === sub_player_id)))
      : [g.t1_player_1_id, g.t1_player_2_id, g.t2_player_1_id, g.t2_player_2_id].indexOf(sub_player_id) !== -1);

  let n = 0;
  updateWhere_('Games', match, g => {
    if (g.t1_team_id === tid) {
      if (g.t1_player_1_id === sub_player_id) g.t1_player_1_id = absent_player_id;
      if (g.t1_player_2_id === sub_player_id) g.t1_player_2_id = absent_player_id;
    } else if (g.t2_team_id === tid) {
      if (g.t2_player_1_id === sub_player_id) g.t2_player_1_id = absent_player_id;
      if (g.t2_player_2_id === sub_player_id) g.t2_player_2_id = absent_player_id;
    } else {
      ['t1_player_1_id', 't1_player_2_id', 't2_player_1_id', 't2_player_2_id'].forEach(k => {
        if (g[k] === sub_player_id) g[k] = absent_player_id;
      });
    }
    g.updated_at = nowStamp_();
    n++;
  });
  if (n) { bumpLeagueVersion_(league_id); cacheBust_('league:' + league_id + ':full'); }
  return { games_reverted: n, week: wk };
}

/** Resolve league + absent/sub players (preferring the Substitutions row the
 *  operator recorded) and apply the sub to that week's snapshots. */
function applyPartnerGameSubByName_(league_query, week, absentName, subName, dryRun) {
  const all = listLeagues_();
  const q = String(league_query).trim().toLowerCase();
  const league = getLeagueById_(league_query) ||
    all.find(l => String(l.name || '').toLowerCase() === q) ||
    all.find(l => String(l.name || '').toLowerCase().indexOf(q) !== -1);
  if (!league) throw new Error('League not found: ' + league_query);
  const lid = league.league_id, wk = Number(week);

  const aL = String(absentName).trim().toLowerCase(), sL = String(subName).trim().toLowerCase();
  // Prefer the Substitutions row the operator just paired (authoritative ids).
  const row = getObjects_('Substitutions').find(s =>
    s.league_id === lid && Number(s.week_number) === wk &&
    String(s.absent_player_name || '').trim().toLowerCase() === aL &&
    String(s.substitute_player_name || '').trim().toLowerCase() === sL);

  let absentId, subId, source;
  if (row) {
    absentId = row.absent_player_id; subId = row.substitute_player_id; source = 'substitution_row';
  } else {
    const players = getObjects_('Players');
    const byName = nmL => players.filter(p => String(p.full_name || '').trim().toLowerCase() === nmL);
    const a = byName(aL), s = byName(sL);
    if (a.length !== 1) throw new Error('Could not uniquely resolve absent "' + absentName + '" (' + a.length + ' matches)');
    if (s.length !== 1) throw new Error('Could not uniquely resolve sub "' + subName + '" (' + s.length + ' matches)');
    absentId = a[0].player_id; subId = s[0].player_id;
    source = 'name_lookup (no matching substitution row found — pairing may not have saved)';
  }
  return applyPartnerGameSub_(lid, wk, absentId, subId, dryRun, { league_name: league.name, source });
}

/** One-off runner: Advanced Partners, week 4 — Daniel Kramer subbed for Emily
 *  Beitel. DRY_RUN=true to preview, flip to false to commit. */
function applyAdvPartnersWk4SubRun() {
  const LEAGUE  = 'Advanced Coed Partners';
  const WEEK    = 4;
  const ABSENT  = 'Emily Beitel';
  const SUB     = 'Daniel Kramer';
  const DRY_RUN = false;
  return applyPartnerGameSubByName_(LEAGUE, WEEK, ABSENT, SUB, DRY_RUN);
}

/**
 * Audit (and optionally fix) every partner league for recorded subs that were
 * never applied to the game results. A case = a `Substitutions` row where the
 * ABSENT player still appears in that week's game snapshots for their own team
 * (so DUPR/Match Results credit the absent regular, not the sub who played).
 * Scoped to the absent player's team so a player who subbed elsewhere the same
 * week isn't wrongly rewritten. Read-only when dryRun; otherwise rewrites all
 * flagged snapshots (absent → sub) in a single pass. Never touches teams,
 * rosters, pairings, or standings.
 *
 * @param {boolean} dryRun
 */
function reconcileAllPartnerSubs_(dryRun) {
  const leagues = listLeagues_().filter(l => l.format_type === 'partner');
  const pById = {}; getObjects_('Players').forEach(p => { pById[p.player_id] = p; });
  const teamById = {}; const teamOfPlayer = {};
  getObjects_('Teams').forEach(t => {
    teamById[t.team_id] = t;
    if (t.player_1_id) teamOfPlayer[t.league_id + ':' + t.player_1_id] = t.team_id;
    if (t.player_2_id) teamOfPlayer[t.league_id + ':' + t.player_2_id] = t.team_id;
  });
  const nm = id => (pById[id] && pById[id].full_name) || id;
  const allGames = getObjects_('Games').filter(g => g.status !== 'voided');
  const subs = getObjects_('Substitutions');

  const cases = [];
  leagues.forEach(league => {
    const lid = league.league_id;
    subs.filter(s => s.league_id === lid && s.absent_player_id && s.substitute_player_id &&
        s.week_number !== '' && s.week_number != null && s.absent_player_id !== s.substitute_player_id)
      .forEach(s => {
        const wk = Number(s.week_number), absentId = s.absent_player_id, subId = s.substitute_player_id;
        const tid = teamOfPlayer[lid + ':' + absentId];   // the absent regular's own team
        const hit = g => {
          if (Number(g.week_number) !== wk || g.league_id !== lid) return false;
          if (tid) {
            return (g.t1_team_id === tid && (g.t1_player_1_id === absentId || g.t1_player_2_id === absentId)) ||
                   (g.t2_team_id === tid && (g.t2_player_1_id === absentId || g.t2_player_2_id === absentId));
          }
          return [g.t1_player_1_id, g.t1_player_2_id, g.t2_player_1_id, g.t2_player_2_id].indexOf(absentId) !== -1;
        };
        const games = allGames.filter(hit);
        if (!games.length) return;   // already applied (or sub never actually played) — skip
        cases.push({
          league_id: lid, league_name: league.name, week: wk,
          team: (teamById[tid] || {}).team_name || tid || '(unknown)',
          absent: { id: absentId, name: nm(absentId) },
          sub:    { id: subId, name: s.substitute_player_name || nm(subId) },
          games: games.length,
          game_ids: games.map(g => g.game_id),
        });
      });
  });

  cases.sort((a, b) => String(a.league_name).localeCompare(b.league_name) || a.week - b.week || String(a.team).localeCompare(b.team));
  const summary = {
    partner_leagues: leagues.map(l => l.name),
    cases_found: cases.length,
    total_games_to_rewrite: cases.reduce((a, c) => a + c.games, 0),
    cases: cases.map(c => ({ league: c.league_name, week: c.week, team: c.team, absent: c.absent.name, sub: c.sub.name, games: c.games })),
    dry_run: !!dryRun,
  };
  // Coverage diagnostic: classify EVERY partner-league Substitutions row so we can
  // see malformed rows the cases logic silently skips, and confirm nothing is left unapplied.
  const cov = { total: 0, valid_applied: 0, valid_unapplied: [], incomplete: 0, no_week: 0, self: 0 };
  const absCount = {};   // tid:wk -> number of distinct absent regulars that week (>=2 => forced loss)
  leagues.forEach(league => {
    const lid = league.league_id;
    subs.filter(s => s.league_id === lid).forEach(s => {
      cov.total++;
      if (!s.absent_player_id || !s.substitute_player_id) { cov.incomplete++; return; }
      if (s.week_number === '' || s.week_number == null) { cov.no_week++; return; }
      if (s.absent_player_id === s.substitute_player_id) { cov.self++; return; }
      const wk = Number(s.week_number), absentId = s.absent_player_id;
      const tid = teamOfPlayer[lid + ':' + absentId];
      if (tid) { const k = tid + ':' + wk; absCount[k] = (absCount[k] || 0) + 1; }
      const stillThere = allGames.some(g => {
        if (Number(g.week_number) !== wk || g.league_id !== lid) return false;
        if (tid && g.t1_team_id !== tid && g.t2_team_id !== tid) return false;
        return [g.t1_player_1_id, g.t1_player_2_id, g.t2_player_1_id, g.t2_player_2_id].indexOf(absentId) !== -1;
      });
      if (stillThere) cov.valid_unapplied.push(league.name.replace(/ \(Team Level.*$/, '') + ' wk' + wk + ' ' + nm(absentId));
      else cov.valid_applied++;
    });
  });
  const forcedLossTeamWeeks = Object.keys(absCount).filter(k => absCount[k] >= 2).length;
  Logger.log('COVERAGE — ' + cov.total + ' partner sub rows | valid+applied: ' + cov.valid_applied +
    ' | still UNAPPLIED: ' + cov.valid_unapplied.length + (cov.valid_unapplied.length ? ' (' + cov.valid_unapplied.join('; ') + ')' : '') +
    ' | incomplete(missing id): ' + cov.incomplete + ' | missing week: ' + cov.no_week + ' | self-ref: ' + cov.self +
    ' | forced-loss(>=2 absent) team-weeks: ' + forcedLossTeamWeeks);

  const compact = 'PARTNER SUB AUDIT — ' + cases.length + ' cases, ' + summary.total_games_to_rewrite + ' games to rewrite:\n' +
    cases.map((c, i) => (i + 1) + '. ' + c.league_name.replace(/ \(Team Level.*$/, '') +
      ' | wk' + c.week + ' | ' + c.team + ' | ' + c.absent.name + ' -> ' + c.sub.name + ' | ' + c.games + 'g').join('\n');
  Logger.log(compact);
  if (dryRun) { return summary; }

  // Commit: one pass over Games, applying every flagged rewrite.
  const rewriteByGame = {};
  cases.forEach(c => c.game_ids.forEach(gid => { (rewriteByGame[gid] = rewriteByGame[gid] || []).push({ absent: c.absent.id, sub: c.sub.id }); }));
  const SLOTS = ['t1_player_1_id', 't1_player_2_id', 't2_player_1_id', 't2_player_2_id'];
  let gamesRewritten = 0;
  updateWhere_('Games', g => !!rewriteByGame[g.game_id], g => {
    rewriteByGame[g.game_id].forEach(r => { SLOTS.forEach(k => { if (g[k] === r.absent) g[k] = r.sub; }); });
    g.updated_at = nowStamp_(); gamesRewritten++;
  });
  const touched = {}; cases.forEach(c => { touched[c.league_id] = true; });
  Object.keys(touched).forEach(lid => { bumpLeagueVersion_(lid); cacheBust_('league:' + lid + ':full'); });
  summary.games_rewritten = gamesRewritten;
  audit_('partner_subs_bulk_reconcile', 'global', 'partner', null, { cases: cases.length, games: gamesRewritten });
  Logger.log(JSON.stringify(summary, null, 2));
  return summary;
}

/** Audit (DRY_RUN=true) every partner league for paired-but-unapplied subs;
 *  flip to false to apply all the fixes at once. */
function auditAllPartnerSubsRun() {
  const DRY_RUN = true;   // audit-only by default; flip to false to commit the rewrites
  return reconcileAllPartnerSubs_(DRY_RUN);
}

/**
 * Self-test for auto-apply-on-pairing: Part A (pairing rewrites existing
 * snapshots), Part B (a freshly-derived snapshot bakes in an already-paired
 * sub), and the unpair revert. Runs on the TEST Partners seed league and
 * leaves it restored (records then voids one sub). Read the log for ALL_PASS.
 */
function testPartnerSubPairingFlowRun() {
  seedTestPartner();
  const out = {};
  const league = listLeagues_().find(l => l.name === 'TEST Partners');
  if (!league) { Logger.log('FAIL: no TEST Partners league'); return; }
  const lid = league.league_id, wk = 1;
  const teams = getObjects_('Teams').filter(t => t.league_id === lid);
  if (teams.length < 2) { Logger.log('FAIL: need >=2 teams'); return; }
  const team = teams[0], otherTeam = teams[1];
  const absentId = team.player_1_id;
  const subPlayer = upsertPlayer_({ full_name: 'ZZ Test Sub', email: 'zz.test.sub@example.com' });
  const subId = subPlayer.player_id;
  const SLOTS = ['t1_player_1_id', 't1_player_2_id', 't2_player_1_id', 't2_player_2_id'];
  const countWith = pid => getObjects_('Games').filter(g => g.league_id === lid && g.status !== 'voided' &&
    Number(g.week_number) === wk && SLOTS.some(k => g[k] === pid)).length;

  out.absent = absentId; out.sub = subId;
  out.before = { absent_in_games: countWith(absentId), sub_in_games: countWith(subId) };

  // Part A: recording the sub should swap absent -> sub in existing snapshots.
  const rec = recordSubstitution_({ league_id: lid, week_number: wk, absent_player_id: absentId, substitute_player_id: subId });
  out.record_snapshot = rec.snapshot;
  out.after_pair = { absent_in_games: countWith(absentId), sub_in_games: countWith(subId) };
  out.partA_ok = out.after_pair.absent_in_games === 0 && out.after_pair.sub_in_games === out.before.absent_in_games;

  // Part B: a freshly-derived snapshot (sub row present) should bake in the sub.
  const fake = { league_id: lid, week_number: wk, t1_team_id: team.team_id, t2_team_id: otherTeam.team_id,
    t1_player_1_id: absentId, t1_player_2_id: team.player_2_id,
    t2_player_1_id: otherTeam.player_1_id, t2_player_2_id: otherTeam.player_2_id };
  applyPairedSubsToGameSnapshot_(fake);
  out.partB_ok = fake.t1_player_1_id === subId;

  // Revert: voiding the sub should restore the absent regular.
  voidSubstitution_(rec.sub_id);
  out.after_void = { absent_in_games: countWith(absentId), sub_in_games: countWith(subId) };
  out.revert_ok = out.after_void.absent_in_games === out.before.absent_in_games && out.after_void.sub_in_games === 0;

  out.ALL_PASS = !!(out.partA_ok && out.partB_ok && out.revert_ok);
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

/**
 * Find or create a team by name in a league. Slot the player into P1 if
 * open, else P2. Errors if the team already has 2 different players.
 */
function slotIntoTeam_(league_id, team_name, player_id) {
  const teams = listTeams_(league_id);
  const name = String(team_name).trim();
  const lower = name.toLowerCase();
  let team = teams.find(t => String(t.team_name).trim().toLowerCase() === lower);

  if (!team) {
    const team_id = makeId_('team');
    appendObjects_('Teams', [{
      team_id:     team_id,
      league_id:   league_id,
      team_name:   name,
      player_1_id: player_id,
      player_2_id: '',
      created_at:  nowStamp_(),
    }]);
    audit_('team_create', 'team', team_id, null, { league_id, team_name: name, player_1_id: player_id });
    return team_id;
  }

  if (team.player_1_id === player_id || team.player_2_id === player_id) return team.team_id;
  if (!team.player_1_id) {
    updateWhere_('Teams', t => t.team_id === team.team_id, t => { t.player_1_id = player_id; });
  } else if (!team.player_2_id) {
    updateWhere_('Teams', t => t.team_id === team.team_id, t => { t.player_2_id = player_id; });
  } else {
    throw new Error('Team "' + name + '" already has 2 players');
  }
  return team.team_id;
}

/**
 * Ladder-format equivalent of `setupTeamsFromCR_` / `bulkRebuildLeagueFromCR_`.
 *
 * Reads CR_Attendance rows whose event_name matches this league (after
 * normalization) and whose registration_type is a "Full" type (full-season
 * registrants, NOT drop-ins / guests / single-session). Dedupes by
 * member_number. For each unique attendee:
 *   - Find the matching Player by club_member_id. Create one if missing.
 *   - Add to Rosters if not already.
 *
 * Idempotent — re-running picks up newly-attended members without duplicating
 * existing Players or Roster rows. Players are NOT removed if they stop
 * appearing in attendance (admin removes via the legacy roster tools).
 *
 * @returns {{ total_attendees, players_added, rosters_added }}
 */
function syncLadderRosterFromAttendance_(league_id) {
  const league = getLeagueById_(league_id);
  if (!league) throw new Error('League not found: ' + league_id);

  const targetName = (league.name || '').trim();
  const isFullEventType = (t) => {
    const s = String(t || '').trim().toLowerCase();
    if (!s) return false;
    if (/drop[\s-]*in|single[\s-]*session|guest|trial/.test(s)) return false;
    return /^full\b|^season\b|^league\b/.test(s);
  };

  const attendance = getObjects_('CR_Attendance').filter(a =>
    _crEventNameMatches_(a.event_name, targetName) &&
    isFullEventType(a.registration_type)
  );

  // Dedupe by member_number — one player can have many sessions.
  const byMember = {};
  attendance.forEach(a => {
    const m = String(a.member_number || '').trim();
    if (!m || byMember[m]) return;
    byMember[m] = a;
  });
  const uniqueAttendees = Object.keys(byMember).map(k => byMember[k]);

  if (!uniqueAttendees.length) {
    return {
      total_attendees: 0,
      players_added:   0,
      rosters_added:   0,
      message:         'No matching CR_Attendance rows. Pull via Admin → Integrations.',
    };
  }

  const beforeIds = {};
  getObjects_('Players').forEach(p => { beforeIds[String(p.player_id).trim()] = true; });

  const existingRoster = getObjects_('Rosters').filter(r => r.league_id === league_id);
  const rosteredPlayerIds = {};
  existingRoster.forEach(r => { rosteredPlayerIds[String(r.player_id).trim()] = true; });

  const stamp = nowStamp_();
  const me = activeUserEmail_();
  const newRosters = [];
  const resolvedPids = {};

  uniqueAttendees.forEach(a => {
    const m = String(a.member_number).trim();
    const fullName = ((a.first_name || '') + ' ' + (a.last_name || '')).trim();
    // The attendance member_number is a CourtReserve MembershipNumber. Resolve
    // it to the canonical cr_member_id and find-or-create the real player via
    // upsertGuestPlayer_ — so a member whose roster row is keyed by their member
    // id is NOT duplicated when their check-in uses their membership number.
    let player;
    try {
      player = upsertGuestPlayer_({ member_number: m, club_member_id: m,
                                    full_name: fullName || ('Member ' + m) });
    } catch (e) { return; }
    const pid = String(player.player_id).trim();
    resolvedPids[pid] = true;
    if (!rosteredPlayerIds[pid]) {
      newRosters.push({
        roster_id: makeId_('roster'),
        league_id: league_id,
        player_id: pid,
        team_id:   '',
        level:     '',
        status:    'active',
        added_at:  stamp,
        added_by:  me,
      });
      rosteredPlayerIds[pid] = true;
    }
  });

  if (newRosters.length) appendObjects_('Rosters', newRosters);
  cacheBust_('league:' + league_id + ':full');

  const playersAdded = Object.keys(resolvedPids).filter(pid => !beforeIds[pid]).length;
  audit_('ladder_roster_sync', 'league', league_id, null, {
    total_attendees: uniqueAttendees.length,
    players_added:   playersAdded,
    rosters_added:   newRosters.length,
  });

  return {
    total_attendees: uniqueAttendees.length,
    players_added:   playersAdded,
    rosters_added:   newRosters.length,
  };
}

/**
 * Add a manual sub to today's session: creates a Player record (if needed)
 * and returns it. Does NOT add a Rosters row — the sub is session-only.
 *
 * Standings logic skips player_ids not on the league's roster, so games
 * involving this sub are recorded but don't affect their season totals or
 * the league's leaderboard.
 *
 * @param {string} league_id   - for the audit trail; not used for roster
 * @param {string} full_name   - free-text name typed by the operator
 * @returns {{ player_id, full_name }}
 */
function addManualSub_(league_id, full_name, level) {
  const name = String(full_name || '').trim();
  if (!name) throw new Error('Name required');
  const lvl = String(level || '').trim();

  const parts = name.split(/\s+/);
  const stamp = nowStamp_();
  const player = {
    player_id:      makeId_('player'),
    full_name:      name,
    first_name:     parts[0] || '',
    last_name:      parts.length > 1 ? parts.slice(1).join(' ') : '',
    email:          '',
    phone:          '',
    gender:         '',
    dupr_id:        '',
    club_member_id: '',
    level:          lvl,
    active:         true,
    notes:          'manual sub via Operator (league ' + league_id + ')',
    created_at:     stamp,
  };
  appendObjects_('Players', [player]);
  audit_('manual_sub_add', 'player', player.player_id, null,
    { league_id, full_name: name, level: lvl });
  return { player_id: player.player_id, full_name: name, level: lvl };
}

/**
 * Search the CourtReserve member directory (CR_Members) by name or email.
 * Returns up to `limit` ranked matches. Powers the operator "write-in sub"
 * picker so every sub resolves to a real cr_member_id (no more free-typed,
 * non-member orphan rows).
 */
function searchMembers_(query, limit) {
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) return [];
  limit = limit || 15;
  const members = getObjects_('CR_Members');
  const matches = [];
  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    const first = String(m.first_name || '').trim();
    const last  = String(m.last_name  || '').trim();
    const full  = (first + ' ' + last).trim();
    const email = String(m.email || '').trim();
    const fl = full.toLowerCase(), ll = last.toLowerCase(), el = email.toLowerCase();
    let score = -1;
    if (fl.indexOf(q) === 0)       score = 0;
    else if (ll.indexOf(q) === 0)  score = 1;
    else if (fl.indexOf(q) !== -1) score = 2;
    else if (el.indexOf(q) !== -1) score = 3;
    if (score < 0) continue;
    matches.push({ score: score,
      cr_member_id: String(m.cr_member_id || '').trim(),
      full_name: full, email: email,
      membership_number: String(m.membership_number || '').trim(),
      status: String(m.membership_status || '').trim() });
    if (matches.length > 400) break;
  }
  matches.sort((a, b) => a.score - b.score || a.full_name.localeCompare(b.full_name));
  return matches.slice(0, limit).map(x => ({
    cr_member_id: x.cr_member_id, full_name: x.full_name,
    email: x.email, membership_number: x.membership_number, status: x.status }));
}

/**
 * Compact CourtReserve member directory for the operator sub picker, loaded
 * once into the browser and filtered client-side (fast typeahead). Rows are
 * [cr_member_id, full_name, email, membership_number].
 */
function memberDirectory_() {
  return getObjects_('CR_Members').map(m => [
    String(m.cr_member_id || '').trim(),
    (String(m.first_name || '').trim() + ' ' + String(m.last_name || '').trim()).trim(),
    String(m.email || '').trim(),
    String(m.membership_number || '').trim(),
  ]).filter(r => r[0] && r[1]);
}

/**
 * Add a write-in sub that MUST be a real CourtReserve member. Resolves the
 * member to a Players row keyed by cr_member_id (creating/enriching it if
 * needed). Replaces the free-text path that created orphan, non-member rows.
 */
function addMemberSub_(league_id, cr_member_id, level) {
  const crid = String(cr_member_id || '').trim();
  if (!crid) throw new Error('Select a member');
  const m = crMemberRow_(crid);
  if (!m) throw new Error('Not a valid CourtReserve member');
  const name = (String(m.first_name || '').trim() + ' ' + String(m.last_name || '').trim()).trim();
  const p = upsertGuestPlayer_({ cr_member_id: crid, club_member_id: crid, full_name: name, level: level });
  audit_('member_sub_add', 'player', p.player_id, null,
    { league_id: league_id, cr_member_id: crid, level: level || '' });
  return { player_id: p.player_id, full_name: p.full_name || name, level: p.level || level || '' };
}

/**
 * Hard-reset a ladder league's roster: drop ALL existing Rosters rows for the
 * league, then re-run `syncLadderRosterFromAttendance_`. Use when an earlier
 * sync (with the now-fixed name matcher) cross-contaminated the roster with
 * sibling-day attendees. Players themselves are NOT deleted — they may be on
 * other leagues' rosters.
 *
 * @returns {{ rosters_dropped, total_attendees, players_added, rosters_added }}
 */
function resetLadderRosterFromAttendance_(league_id) {
  const league = getLeagueById_(league_id);
  if (!league) throw new Error('League not found: ' + league_id);

  // 1. Drop existing roster rows for this league.
  const all = getObjects_('Rosters');
  const keep = all.filter(r => r.league_id !== league_id);
  const dropped = all.length - keep.length;
  overwriteObjects_('Rosters', keep);
  cacheBust_('league:' + league_id + ':full');
  audit_('league_reset_ladder_roster', 'league', league_id, null, { rosters_dropped: dropped });

  // 2. Re-sync from attendance.
  const sync = syncLadderRosterFromAttendance_(league_id);

  return {
    rosters_dropped: dropped,
    total_attendees: sync.total_attendees,
    players_added:   sync.players_added,
    rosters_added:   sync.rosters_added,
  };
}

