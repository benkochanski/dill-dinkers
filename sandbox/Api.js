/**
 * Client-callable API surface. Every entry point either:
 *   - is the login call itself (no auth), OR
 *   - takes a token first arg and calls requireAdmin_(token).
 *
 * Public DUPR-link endpoints (player-facing) are NOT here — they're rendered
 * server-side via Web.js so the player never holds a token.
 */

/* ----- Admin auth ----- */
function api_login(email, password) {
  return wrap_(() => adminLogin_(email, password));
}

function api_logout(token) {
  return wrap_(() => adminLogout_(token));
}

/* ----- Player management ----- */
function api_listPlayers(token) {
  return wrap_(() => {
    requireAdmin_(token);
    return getObjects_('Players').map(p => ({
      player_id:             p.player_id,
      full_name:             p.full_name,
      dupr_partial_name:     p.dupr_partial_name || '',
      dupr_full_name:        p.dupr_full_name || '',
      email:                 p.email,
      phone:                 p.phone || '',
      gender:                p.gender || '',
      dupr_age:              p.dupr_age === '' ? null : Number(p.dupr_age),
      dupr_birth_year:       p.dupr_birth_year === '' ? null : Number(p.dupr_birth_year),
      dupr_location:         p.dupr_location || '',
      dupr_id:               p.dupr_id || '',
      dupr_player_uuid:      p.dupr_player_uuid || '',
      dupr_doubles_rating:           p.dupr_doubles_rating || '',
      dupr_doubles_reliable:         p.dupr_doubles_reliable === true || p.dupr_doubles_reliable === 'TRUE',
      dupr_doubles_rating_current:   p.dupr_doubles_rating_current || '',
      dupr_doubles_reliable_current: p.dupr_doubles_reliable_current === true || p.dupr_doubles_reliable_current === 'TRUE',
      dupr_doubles_current_updated_at: fmtDisplayStamp_(p.dupr_doubles_current_updated_at),
      dupr_doubles_wins:             p.dupr_doubles_wins   === '' ? null : Number(p.dupr_doubles_wins),
      dupr_doubles_losses:           p.dupr_doubles_losses === '' ? null : Number(p.dupr_doubles_losses),
      dupr_doubles_total:            p.dupr_doubles_total  === '' ? null : Number(p.dupr_doubles_total),
      dupr_singles_rating:           p.dupr_singles_rating || '',
      dupr_singles_reliable:         p.dupr_singles_reliable === true || p.dupr_singles_reliable === 'TRUE',
      dupr_singles_wins:             p.dupr_singles_wins   === '' ? null : Number(p.dupr_singles_wins),
      dupr_singles_losses:           p.dupr_singles_losses === '' ? null : Number(p.dupr_singles_losses),
      dupr_singles_total:            p.dupr_singles_total  === '' ? null : Number(p.dupr_singles_total),
      has_basic_l1:                  p.has_basic_l1    === true || p.has_basic_l1    === 'TRUE',
      has_premium_l1:                p.has_premium_l1  === true || p.has_premium_l1  === 'TRUE',
      has_verified_l1:               p.has_verified_l1 === true || p.has_verified_l1 === 'TRUE',
      entitlements_fetched_at:       fmtDisplayStamp_(p.entitlements_fetched_at),
      link_source:           p.link_source || '',
      linked_at:             p.linked_at || '',
      created_at:            fmtDisplayStamp_(p.created_at),
      active:                p.active !== false && p.active !== 'FALSE',
    }));
  });
}

/**
 * Hard-delete a player. The Players row is removed entirely so the same
 * DUPR account can be re-registered (no duplicate-dupr_id conflict).
 *
 * Game records keep the names because we snapshot t*_player_*_name at save
 * time. For games that pre-date that snapshot, names fall back to the
 * Players lookup — once the player is gone they'll show "?". Run
 * backfillGamePlayerNames() before bulk deletes if you need pristine history.
 */
function api_deletePlayer(token, player_id) {
  return wrap_(() => {
    requireAdmin_(token);
    if (!player_id) throw new Error('player_id required');
    const all = getObjects_('Players');
    const before = all.find(p => p.player_id === player_id);
    if (!before) throw new Error('Player not found');
    const remaining = all.filter(p => p.player_id !== player_id);
    overwriteObjects_('Players', remaining);
    audit_('player_hard_delete', 'player', player_id, before, null);
    return { ok: true, player_id: player_id, full_name: before.full_name };
  });
}

/**
 * Backfill name snapshots on existing game rows. Run once after the snapshot
 * columns are added by bootstrap() so historical games carry names too.
 * Idempotent — only fills blank snapshots, never overwrites.
 */
function backfillGamePlayerNames() {
  const players = getObjects_('Players');
  const nameById = {};
  players.forEach(p => { nameById[p.player_id] = String(p.full_name || '').trim(); });
  let touched = 0;
  updateWhere_('Games', () => true, g => {
    let changed = false;
    [['t1_player_1_id', 't1_player_1_name'],
     ['t1_player_2_id', 't1_player_2_name'],
     ['t2_player_1_id', 't2_player_1_name'],
     ['t2_player_2_id', 't2_player_2_name']].forEach(pair => {
      if (!g[pair[1]] && g[pair[0]] && nameById[g[pair[0]]]) {
        g[pair[1]] = nameById[g[pair[0]]];
        changed = true;
      }
    });
    if (changed) touched++;
  });
  Logger.log('Backfilled names on %s games.', touched);
  return { touched: touched };
}

function api_addPlayer(token, input) {
  return wrap_(() => {
    requireAdmin_(token);
    if (!input || !input.full_name) throw new Error('full_name required');
    const email = String(input.email || '').toLowerCase().trim();
    const players = getObjects_('Players');
    if (email && players.find(p => String(p.email || '').toLowerCase().trim() === email)) {
      throw new Error('A player with that email already exists');
    }
    const fullName = String(input.full_name).trim();
    const player = {
      player_id:        makeId_('player'),
      full_name:        fullName,
      first_name:       String(input.first_name || fullName.split(/\s+/)[0] || '').trim(),
      last_name:        String(input.last_name  || fullName.split(/\s+/).slice(1).join(' ') || '').trim(),
      email:            email,
      phone:            String(input.phone || '').trim(),
      gender:           String(input.gender || '').trim(),
      dupr_id:          '',
      dupr_player_uuid: '',
      link_source:      '',
      linked_at:        '',
      cr_member_id:     String(input.cr_member_id || '').trim(),
      active:           true,
      notes:            String(input.notes || '').trim(),
      created_at:       nowStamp_(),
    };
    appendObjects_('Players', [player]);
    audit_('player_create', 'player', player.player_id, null, { full_name: fullName, email: email });
    return player;
  });
}

/**
 * Build the per-player DUPR-link URL the admin can share with each player.
 * That URL is the ONLY way to set dupr_id from inside the sandbox — it
 * triggers the DUPR OAuth flow.
 */
function api_getLinkUrl(token, player_id) {
  return wrap_(() => {
    requireAdmin_(token);
    if (!player_id) throw new Error('player_id required');
    const url = ScriptApp.getService().getUrl() + '?page=link&pid=' + encodeURIComponent(player_id);
    return { url: url };
  });
}

/**
 * Player-facing endpoint — called from Link.html when the DUPR SSO iframe
 * fires its postMessage. No admin token; instead authorized via the
 * one-time `state` nonce that Web.renderLink_ issued.
 */
function api_finalizeDuprLink(state, payload) {
  return wrap_(() => duprFinalizeSso_(state, payload || {}));
}

/**
 * Merge consented fields from the SSO postMessage into a profile object.
 * DUPR's by-id API masks the last name ("Augie S.") and omits PII; the
 * postMessage carries the unmasked, user-consented data. We prefer the
 * postMessage values when present. Also stashes the raw payload to
 * Audit_Log once per DUPR ID so we can confirm DUPR's field names.
 */
function mergeSsoConsentedFields_(profile, raw, duprId) {
  if (!raw) return profile;
  let d;
  try { d = (typeof raw === 'string') ? JSON.parse(raw) : raw; } catch (e) { return profile; }
  if (!d || typeof d !== 'object') return profile;
  // The consented data may be nested (e.g. d.user, d.profile) — flatten common shapes.
  const u = d.user || d.profile || d.result || d;
  const pick = (obj, keys) => {
    for (let i = 0; i < keys.length; i++) {
      const v = obj && obj[keys[i]];
      if (v != null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
  };
  const ssoFull   = pick(u, ['fullName', 'full_name', 'name', 'displayName']);
  const ssoFirst  = pick(u, ['firstName', 'first_name', 'givenName']);
  const ssoLast   = pick(u, ['lastName', 'last_name', 'familyName', 'surname']);
  const ssoGender = pick(u, ['gender', 'sex']);
  const ssoEmail  = pick(u, ['email', 'emailAddress']);
  const ssoPhone  = pick(u, ['phone', 'phoneNumber', 'mobile']);
  // Prefer SSO (unmasked) values. Keep masked by-id name as a fallback.
  if (ssoFull)  profile.dupr_full_name = ssoFull;
  if (ssoFull)  profile.full_name      = ssoFull;
  if (ssoFirst) profile.first_name     = ssoFirst;
  if (ssoLast)  profile.last_name      = ssoLast;
  if (ssoGender) profile.gender        = ssoGender;
  if (ssoEmail)  profile.email         = ssoEmail;
  if (ssoPhone)  profile.phone         = ssoPhone;
  // One-time stash of the raw payload so we can see DUPR's exact schema.
  try {
    const marker = CacheService.getScriptCache().get('sso_raw_logged:' + duprId);
    if (!marker) {
      audit_('sso_payload_raw', 'registration', duprId, null,
        { keys: Object.keys(u || {}), raw: String(raw).slice(0, 1500) });
      CacheService.getScriptCache().put('sso_raw_logged:' + duprId, '1', 3600);
    }
  } catch (e) { /* swallow */ }
  return profile;
}

/**
 * Public — fetch a DUPR user's profile right after SSO so the registration
 * page can show their name/rating/W-L for confirmation. Doesn't write
 * anything to the Sheet. State nonce required (not consumed; that happens
 * only on api_completeRegistration).
 */
function api_fetchDuprProfile(state, ssoPayload) {
  return wrap_(() => {
    if (!state) throw new Error('state required');
    if (!CacheService.getScriptCache().get('dupr_reg_state:' + state)) {
      throw new Error('state expired or unknown — reload the registration page');
    }
    const sso = ssoPayload || {};
    const duprId    = String(sso.duprId || sso.dupr_id || '').trim();
    const userToken = String(sso.userToken || '').trim();
    if (!duprId) throw new Error('DUPR ID missing from SSO payload');
    const profile = duprFetchUserProfile_(duprId, userToken);
    // Merge any consented fields the SSO postMessage delivered (full name,
    // gender, email). DUPR's by-id endpoint masks the last name; the
    // postMessage carries what the player agreed to share. Stash the raw
    // payload once so we can see DUPR's exact field names.
    mergeSsoConsentedFields_(profile, sso.raw, duprId);
    // Also pull entitlements so the confirmation page can show everything
    // we collected. Don't fail the preview if this errors — registration
    // re-checks it strictly anyway.
    try {
      if (userToken) {
        const ent = duprFetchUserEntitlements_(userToken);
        profile.entitlements      = ent.tournaments || [];
        profile.has_basic_l1      = !!ent.has_basic_l1;
        profile.has_premium_l1    = !!ent.has_premium_l1;
        profile.has_verified_l1   = !!ent.has_verified_l1;
      }
    } catch (e) {
      profile.entitlements_error = String(e && e.message || e);
    }
    return profile;
  });
}

/**
 * Public self-service registration. Called from Register.html on submit.
 * Validates the state nonce, re-fetches the DUPR profile server-side (so
 * the client can't lie about stats), and creates a Players row with
 * everything in one shot.
 */
function api_completeRegistration(state, formData, ssoPayload) {
  return wrap_(() => {
    if (!state) throw new Error('state required (page reload may have stripped it)');
    const cache = CacheService.getScriptCache();
    const marker = cache.get('dupr_reg_state:' + state);
    if (!marker) throw new Error('state expired or unknown — reload the registration page');

    const form = formData || {};
    const sso  = ssoPayload || {};
    const fullName = String(form.full_name || '').trim();
    const duprId   = String(sso.duprId || sso.dupr_id || '').trim();
    const duprUuid = String(sso.id || sso.userId || '').trim();

    if (!fullName) throw new Error('Name required');
    if (!duprId)   throw new Error('Please complete the DUPR sign-in before submitting');

    const players = getObjects_('Players');
    const dupDupr = players.find(p => String(p.dupr_id || '').trim() === duprId);
    if (dupDupr)  throw new Error('That DUPR account is already linked to another registration');
    // Email may come from DUPR's /me profile (set further down). If present
    // there and already used, surface a soft error.
    const email = ''; // form no longer captures this; will overwrite from profile below if present

    // Re-fetch the profile server-side so client-side data can't be spoofed.
    const userToken    = String(sso.userToken    || '').trim();
    const refreshToken = String(sso.refreshToken || '').trim();
    let profile = {};
    try { profile = duprFetchUserProfile_(duprId, userToken); }
    catch (e) {
      // Don't fail registration if DUPR is temporarily flaky — just save
      // what we have. Stats can be re-fetched later.
      profile = { dupr_id: duprId };
    }
    // Merge the consented (unmasked) fields from the SSO postMessage.
    mergeSsoConsentedFields_(profile, sso.raw, duprId);

    // DUPR gating per RaaS spec — strict enforcement.
    // POST /subscription/active on api.uat.dupr.gg with the user's SSO Bearer.
    // No graceful degrade: if we can't verify BASIC_L1, registration is rejected.
    if (!userToken) throw new Error('SSO did not return a user token — re-link and try again');
    let entitlements;
    try {
      entitlements = duprFetchUserEntitlements_(userToken);
    } catch (e) {
      audit_('entitlements_fetch_failed', 'registration', duprId, null,
        { error: String(e && e.message || e).slice(0, 500) });
      throw new Error('Could not verify DUPR entitlements: ' + (e && e.message || e));
    }
    const entitlementsFetched = true;
    if (!entitlements.has_basic_l1) {
      throw new Error('Your DUPR account does not have the BASIC_L1 entitlement required to register. Contact DUPR support if you believe this is in error.');
    }

    // Email/phone may have come back from DUPR's /me — use profile values
    // when present, otherwise leave blank. Form no longer collects either.
    const profileEmail = String(profile.email || '').toLowerCase().trim();
    const profilePhone = String(profile.phone || '').trim();
    if (profileEmail) {
      const dupEmail = players.find(p => String(p.email || '').toLowerCase().trim() === profileEmail);
      if (dupEmail) throw new Error('Your DUPR-registered email is already in use by another roster entry');
    }

    cache.remove('dupr_reg_state:' + state);

    const stamp = nowStamp_();
    const player = {
      player_id:                       makeId_('player'),
      full_name:                       fullName,
      first_name:                      fullName.split(/\s+/)[0] || '',
      last_name:                       fullName.split(/\s+/).slice(1).join(' ') || '',
      email:                           profileEmail,
      phone:                           profilePhone,
      gender:                          String(profile.gender || '').trim(),
      dupr_age:                        profile.age == null ? '' : profile.age,
      dupr_birth_year:                 profile.birth_year == null ? '' : profile.birth_year,
      dupr_location:                   String(profile.location || '').trim(),
      dupr_id:                         duprId,
      dupr_player_uuid:                duprUuid,
      dupr_partial_name:                       profile.dupr_partial_name || '',
      dupr_full_name:                          profile.dupr_full_name || '',
      dupr_short_name:                         '',
      // LOCKED — captured once at registration.
      dupr_doubles_rating:                     profile.doubles_rating || '',
      dupr_doubles_reliable:                   profile.doubles_reliable ? 'TRUE' : 'FALSE',
      dupr_doubles_reliability_score:          profile.doubles_reliability_score == null ? '' : profile.doubles_reliability_score,
      // CURRENT — seeded with same values at registration; updated by webhook/cron going forward.
      dupr_doubles_rating_current:             profile.doubles_rating || '',
      dupr_doubles_reliable_current:           profile.doubles_reliable ? 'TRUE' : 'FALSE',
      dupr_doubles_reliability_score_current:  profile.doubles_reliability_score == null ? '' : profile.doubles_reliability_score,
      dupr_doubles_current_updated_at:         profile.full_name ? stamp : '',
      dupr_doubles_wins:                       profile.doubles_wins   == null ? '' : profile.doubles_wins,
      dupr_doubles_losses:                     profile.doubles_losses == null ? '' : profile.doubles_losses,
      dupr_doubles_total:                      profile.doubles_total  == null ? '' : profile.doubles_total,
      // Singles — informational, current-only.
      dupr_singles_rating:                     profile.singles_rating || '',
      dupr_singles_reliable:                   profile.singles_reliable ? 'TRUE' : 'FALSE',
      dupr_singles_reliability_score:          profile.singles_reliability_score == null ? '' : profile.singles_reliability_score,
      dupr_singles_wins:                       profile.singles_wins   == null ? '' : profile.singles_wins,
      dupr_singles_losses:                     profile.singles_losses == null ? '' : profile.singles_losses,
      dupr_singles_total:                      profile.singles_total  == null ? '' : profile.singles_total,
      dupr_singles_updated_at:                 profile.full_name ? stamp : '',
      dupr_stats_fetched_at:                   profile.full_name ? stamp : '',
      // Entitlements (gating) — only write TRUE/FALSE if we actually got
      // data back. If the fetch failed (path discovery still pending in UAT)
      // leave the columns blank so the push gate treats this player as
      // "unknown" (no-op) rather than "explicitly missing BASIC_L1".
      entitlements_tournaments:                entitlementsFetched ? (entitlements.tournaments || []).join(',') : '',
      has_basic_l1:                            entitlementsFetched ? (entitlements.has_basic_l1    ? 'TRUE' : 'FALSE') : '',
      has_premium_l1:                          entitlementsFetched ? (entitlements.has_premium_l1  ? 'TRUE' : 'FALSE') : '',
      has_verified_l1:                         entitlementsFetched ? (entitlements.has_verified_l1 ? 'TRUE' : 'FALSE') : '',
      entitlements_fetched_at:                 entitlementsFetched ? stamp : '',
      // User tokens for daily re-fetch (read-only scope per DUPR spec)
      dupr_user_token:                         userToken,
      dupr_refresh_token:                      refreshToken,
      link_source:                     'sso',
      linked_at:                       stamp,
      cr_member_id:                    '',
      active:                          true,
      notes:                           'self-registered',
      created_at:                      stamp,
    };
    appendObjects_('Players', [player]);
    audit_('player_self_register', 'player', player.player_id, null, {
      dupr_id: duprId, email: email, rating: profile.doubles_rating || ''
    });
    return {
      player_id:        player.player_id,
      dupr_id:          duprId,
      full_name:        fullName,
      dupr_full_name:   profile.full_name || '',
      doubles_rating:   profile.doubles_rating || '',
      doubles_reliable: !!profile.doubles_reliable,
      doubles_wins:     profile.doubles_wins || 0,
      doubles_losses:   profile.doubles_losses || 0,
    };
  });
}

/* ----- Games / score submit ----- */
function api_saveGame(token, input) {
  return wrap_(() => {
    requireAdmin_(token);
    if (!input) throw new Error('input required');
    const pids = [input.t1_player_1_id, input.t1_player_2_id, input.t2_player_1_id, input.t2_player_2_id];
    if (pids.some(p => !p)) throw new Error('All four player IDs required');
    if (new Set(pids).size !== 4) throw new Error('Each player can only appear once per match');
    const t1s = Number(input.t1_score);
    const t2s = Number(input.t2_score);
    if (!Number.isFinite(t1s) || !Number.isFinite(t2s)) throw new Error('Scores must be numeric');

    const winner = t1s > t2s ? 't1' : t1s < t2s ? 't2' : 'tie';
    const stamp = nowStamp_();
    // Snapshot names so games stay readable after hard-deleting a player.
    const players = getObjects_('Players');
    const nameOf = pid => {
      const p = players.find(x => x.player_id === pid);
      return p ? String(p.full_name || '').trim() : '';
    };
    const row = {
      game_id:          makeId_('game'),
      play_date:        String(input.play_date || formatDuprDate_(new Date())),
      event_label:      String(input.event_label || ''),
      t1_player_1_id:   input.t1_player_1_id,
      t1_player_2_id:   input.t1_player_2_id,
      t2_player_1_id:   input.t2_player_1_id,
      t2_player_2_id:   input.t2_player_2_id,
      t1_player_1_name: nameOf(input.t1_player_1_id),
      t1_player_2_name: nameOf(input.t1_player_2_id),
      t2_player_1_name: nameOf(input.t2_player_1_id),
      t2_player_2_name: nameOf(input.t2_player_2_id),
      t1_score:         t1s,
      t2_score:         t2s,
      winner:           winner,
      status:           'complete',
      dupr_match_id:    '',
      dupr_push_status: 'pending',
      dupr_push_error:  '',
      entered_by:       activeUserEmail_(),
      entered_at:       stamp,
      updated_at:       stamp,
      notes:            String(input.notes || ''),
    };
    appendObjects_('Games', [row]);
    audit_('game_save', 'game', row.game_id, null, { score: t1s + '-' + t2s, winner: winner });
    return row;
  });
}

function api_listGames(token) {
  return wrap_(() => {
    requireAdmin_(token);
    const toMs = v => {
      if (!v) return 0;
      if (v instanceof Date) return v.getTime();
      const d = new Date(v);
      return isNaN(d.getTime()) ? 0 : d.getTime();
    };
    return getObjects_('Games').slice().sort((a, b) => toMs(b.entered_at) - toMs(a.entered_at));
  });
}

function api_voidGame(token, game_id) {
  return wrap_(() => {
    requireAdmin_(token);
    if (!game_id) throw new Error('game_id required');
    const before = getObjects_('Games').find(g => g.game_id === game_id);
    if (!before) throw new Error('Game not found');
    // If the game was pushed to DUPR, delete it there first.
    let deletedFromDupr = false;
    if (before.status === 'pushed' && before.dupr_match_id) {
      duprDeleteMatch_(game_id);  // throws on failure → we abort void
      deletedFromDupr = true;
    }
    updateWhere_('Games', g => g.game_id === game_id, g => {
      g.status         = 'voided';
      g.dupr_push_status = deletedFromDupr ? 'deleted' : g.dupr_push_status;
      g.updated_at     = nowStamp_();
    });
    audit_('game_void', 'game', game_id, before, { deleted_from_dupr: deletedFromDupr });
    return { ok: true, deleted_from_dupr: deletedFromDupr };
  });
}

function api_updateGameOnDupr(token, game_id) {
  return wrap_(() => {
    requireAdmin_(token);
    if (!game_id) throw new Error('game_id required');
    return duprUpdateMatch_(game_id);
  });
}

/**
 * Edit a game's scores. If the game has already been pushed to DUPR, the
 * update is also sent to DUPR via /match/v1.0/update — keeping our row and
 * DUPR's record in sync. Voided games cannot be edited.
 */
function api_editGameScores(token, game_id, t1_score, t2_score) {
  return wrap_(() => {
    requireAdmin_(token);
    if (!game_id) throw new Error('game_id required');
    const game = getObjects_('Games').find(g => g.game_id === game_id);
    if (!game) throw new Error('Game not found');
    if (game.status === 'voided') throw new Error('Cannot edit a voided game');
    const t1 = Number(t1_score);
    const t2 = Number(t2_score);
    if (!Number.isFinite(t1) || !Number.isFinite(t2)) throw new Error('Scores must be numeric');
    const winner = t1 > t2 ? 't1' : t1 < t2 ? 't2' : 'tie';
    const before = Object.assign({}, game);
    updateWhere_('Games', g => g.game_id === game_id, g => {
      g.t1_score   = t1;
      g.t2_score   = t2;
      g.winner     = winner;
      g.updated_at = nowStamp_();
    });
    audit_('game_score_edit', 'game', game_id, before, { t1_score: t1, t2_score: t2 });
    if (game.status === 'pushed' && game.dupr_match_id) {
      const r = duprUpdateMatch_(game_id);
      return { ok: true, updated_on_dupr: true, dupr_match_id: r.dupr_match_id };
    }
    return { ok: true, updated_on_dupr: false };
  });
}

/* ----- DUPR push ----- */
function api_pushGameToDupr(token, game_id) {
  return wrap_(() => {
    requireAdmin_(token);
    if (!game_id) throw new Error('game_id required');
    return duprPushMatch_(game_id);
  });
}

function api_listPushLog(token, game_id) {
  return wrap_(() => {
    requireAdmin_(token);
    const toMs = v => {
      if (!v) return 0;
      if (v instanceof Date) return v.getTime();
      const d = new Date(v);
      return isNaN(d.getTime()) ? 0 : d.getTime();
    };
    const all = getObjects_('DUPR_Push_Log');
    return (game_id ? all.filter(r => r.game_id === game_id) : all)
      .sort((a, b) => toMs(b.attempted_at) - toMs(a.attempted_at));
  });
}

function api_registerDuprWebhook(token, webhookUrl) {
  return wrap_(() => {
    requireAdmin_(token);
    const url = String(webhookUrl || '').trim() ||
                PropertiesService.getScriptProperties().getProperty('DUPR_WEBHOOK_URL') ||
                ScriptApp.getService().getUrl();
    // Persist so future calls and the UI remember it.
    if (webhookUrl) {
      PropertiesService.getScriptProperties().setProperty('DUPR_WEBHOOK_URL', url);
    }
    return duprRegisterWebhook_(url, ['RATING']);
  });
}

function api_getWebhookUrl(token) {
  return wrap_(() => {
    requireAdmin_(token);
    return {
      stored: PropertiesService.getScriptProperties().getProperty('DUPR_WEBHOOK_URL') || '',
      default: ScriptApp.getService().getUrl(),
    };
  });
}

function api_listDuprWebhooks(token) {
  return wrap_(() => {
    requireAdmin_(token);
    return duprListWebhooks_();
  });
}

function api_exportAuditLogCsv(token) {
  return wrap_(() => {
    requireAdmin_(token);
    const toMs = v => {
      if (!v) return 0;
      if (v instanceof Date) return v.getTime();
      const d = new Date(v);
      return isNaN(d.getTime()) ? 0 : d.getTime();
    };
    const rows = getObjects_('Audit_Log')
      .slice()
      .sort((a, b) => toMs(b.timestamp) - toMs(a.timestamp));
    const headers = ['audit_id','timestamp','actor_email','action','entity_type','entity_id','old_value','new_value'];
    const escape = v => {
      const s = v == null ? '' : (v instanceof Date ? v.toISOString() : String(v));
      if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };
    const lines = [headers.join(',')];
    rows.forEach(r => lines.push(headers.map(h => escape(r[h])).join(',')));
    return { csv: lines.join('\n'), count: rows.length };
  });
}

function api_listAuditLog(token, limit) {
  return wrap_(() => {
    requireAdmin_(token);
    const n = limit && limit > 0 ? Number(limit) : 100;
    const toMs = v => {
      if (!v) return 0;
      if (v instanceof Date) return v.getTime();
      const d = new Date(v);
      return isNaN(d.getTime()) ? 0 : d.getTime();
    };
    return getObjects_('Audit_Log')
      .slice()
      .sort((a, b) => toMs(b.timestamp) - toMs(a.timestamp))
      .slice(0, n)
      .map(r => ({
        audit_id:    r.audit_id,
        timestamp:   fmtDisplayStamp_(r.timestamp),
        actor_email: r.actor_email || '',
        action:      r.action || '',
        entity_type: r.entity_type || '',
        entity_id:   r.entity_id || '',
        old_value:   (r.old_value || '').toString().slice(0, 200),
        new_value:   (r.new_value || '').toString().slice(0, 200),
      }));
  });
}

function api_listWebhookLog(token, limit) {
  return wrap_(() => {
    requireAdmin_(token);
    const n = limit && limit > 0 ? Number(limit) : 50;
    const toMs = v => {
      if (!v) return 0;
      if (v instanceof Date) return v.getTime();
      const d = new Date(v);
      return isNaN(d.getTime()) ? 0 : d.getTime();
    };
    return getObjects_('Webhook_Log')
      .slice()
      .sort((a, b) => toMs(b.received_at) - toMs(a.received_at))
      .slice(0, n)
      .map(r => {
        // Try to pull the inbound clientId out of the raw payload for display.
        let inbound_client_id = '';
        try {
          const parsed = JSON.parse(r.raw_payload || '{}');
          inbound_client_id = String(parsed.clientId || '');
        } catch (e) { /* leave blank */ }
        return Object.assign({}, r, {
          inbound_client_id: inbound_client_id,
          raw_payload:       (r.raw_payload || '').toString().slice(0, 500),
        });
      });
  });
}

function api_duprClubStatus(token) {
  return wrap_(() => {
    requireAdmin_(token);
    const cfg = duprClubConfig_();
    if (!cfg.club_id || !cfg.admin_dupr_id) {
      return { configured: false };
    }
    try {
      const r = ensureAdminClubRole_();
      return Object.assign({ configured: true }, r);
    } catch (e) {
      return {
        configured: true,
        error: String(e && e.message || e),
        club_id: cfg.club_id,
        admin_dupr_id: cfg.admin_dupr_id,
      };
    }
  });
}

function api_refreshDuprClubRole(token) {
  return wrap_(() => {
    requireAdmin_(token);
    return refreshAdminClubRole_();
  });
}

function api_duprStatus(token) {
  return wrap_(() => {
    requireAdmin_(token);
    return {
      configured: duprConfigured_(),
      base_url:   duprConfig_().base_url,
      has_client_id:     !!duprConfig_().client_id,
      has_client_secret: !!duprConfig_().client_secret,
      has_partner_token: !!duprConfig_().partner_token,
    };
  });
}
