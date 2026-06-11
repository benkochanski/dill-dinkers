/**
 * Tab definitions for the sandbox sheet. Bootstrap.js reads this to create
 * or extend tabs. Source of truth for the sandbox schema.
 *
 * Design notes:
 * - `Players.dupr_id` is populated EXCLUSIVELY via the SSO link flow
 *   (DuprApi.js). The Operator score-submit UI is read-only on dupr_id.
 * - `link_source` records how the dupr_id was captured: 'sso' (compliant),
 *   'cr_propagation' (downstream from CourtReserve, future), or 'legacy'
 *   (pre-existing values from before sandbox). Empty for unlinked players.
 * - `Games` mirrors the prod schema's shape for partner doubles only.
 *   No team_id — just four player_ids per game.
 * - `DUPR_Push_Log` records every match push attempt for audit + retry.
 */

const SCHEMA = {
  Players: {
    notes: 'Roster. dupr_id is set only via DUPR SSO link flow.',
    columns: [
      'player_id', 'full_name', 'first_name', 'last_name',
      'email', 'phone', 'gender',
      'dupr_age', 'dupr_birth_year', 'dupr_location',  // from DUPR /details (consented scopes)
      'dupr_id', 'dupr_player_uuid',
      'dupr_partial_name',                       // masked name from by-id API ("Ahmad E.") — always available
      'dupr_full_name',                          // unmasked full name from /details ("Ahmad Elliott") — consented
      'dupr_short_name',                         // legacy/unused
      // LOCKED at registration time — never overwritten by webhook or cron.
      'dupr_doubles_rating',                     // rating captured at sign-up (immutable)
      'dupr_doubles_reliable',                   // TRUE/FALSE at sign-up
      'dupr_doubles_reliability_score',          // 0..1 at sign-up
      // CURRENT — updated by webhook + daily refresh.
      'dupr_doubles_rating_current',             // latest rating from DUPR
      'dupr_doubles_reliable_current',           // TRUE/FALSE latest
      'dupr_doubles_reliability_score_current',  // 0..1 latest
      'dupr_doubles_current_updated_at',         // when the *_current fields were last refreshed
      // Doubles career stats — always reflect current, refreshed alongside rating.
      'dupr_doubles_wins',
      'dupr_doubles_losses',
      'dupr_doubles_total',
      // Singles — informational (doubles league), current-only, refreshed by cron/webhook.
      'dupr_singles_rating',
      'dupr_singles_reliable',
      'dupr_singles_reliability_score',
      'dupr_singles_wins',
      'dupr_singles_losses',
      'dupr_singles_total',
      'dupr_singles_updated_at',
      'dupr_stats_fetched_at',
      // DUPR entitlements (gating per DUPR RaaS spec, max 24h cache).
      'entitlements_tournaments',         // CSV of entitlements, e.g. "BASIC_L1,PREMIUM_L1"
      'has_basic_l1',                     // TRUE/FALSE — required for any match push
      'has_premium_l1',                   // TRUE/FALSE — required for Premium Events
      'has_verified_l1',                  // TRUE/FALSE — required for Verified resources
      'entitlements_fetched_at',          // when entitlements were last refreshed
      // Sensitive — user-context tokens. Used only to refresh entitlements
      // for THIS user. Per DUPR docs: read-only, cannot modify user data.
      'dupr_user_token',
      'dupr_refresh_token',
      'link_source',                   // 'sso' | 'cr_propagation' | 'legacy' | ''
      'linked_at',
      'cr_member_id',
      'active', 'notes',
      'created_at',
    ],
  },

  Games: {
    notes: 'Partner doubles only. One row per match. Pushed to DUPR on save.',
    columns: [
      'game_id', 'play_date',
      'event_label',
      't1_player_1_id', 't1_player_2_id',
      't2_player_1_id', 't2_player_2_id',
      // Name snapshots — captured at save time so the game record reads
      // correctly even after a player is hard-deleted from Players.
      't1_player_1_name', 't1_player_2_name',
      't2_player_1_name', 't2_player_2_name',
      't1_score', 't2_score',
      'winner',          // 't1' | 't2' | 'tie'
      'status',          // 'open' | 'complete' | 'voided' | 'pushed'
      'dupr_match_id',   // set after successful DUPR push
      'dupr_push_status', // 'pending' | 'success' | 'error'
      'dupr_push_error',
      'entered_by', 'entered_at',
      'updated_at', 'notes',
    ],
  },

  DUPR_Push_Log: {
    notes: 'One row per push attempt. Survives game updates.',
    columns: [
      'push_id', 'game_id', 'attempted_at',
      'status',           // 'success' | 'error'
      'http_status',
      'request_payload',  // truncated JSON
      'response_body',    // truncated JSON
      'dupr_match_id',
      'error_message',
      'attempted_by',
    ],
  },

  Admin_Sessions: {
    notes: 'Test-admin session tokens. Expires column is epoch millis.',
    columns: ['token', 'email', 'created_at', 'expires_at'],
  },

  Audit_Log: {
    notes: 'Generic audit trail. Append-only.',
    columns: [
      'audit_id', 'timestamp', 'actor_email',
      'action', 'entity_type', 'entity_id',
      'old_value', 'new_value',
    ],
  },

  Webhook_Log: {
    notes: 'DUPR webhook receipts. Append-only; one row per inbound POST.',
    columns: [
      'webhook_id', 'received_at',
      'event',                 // 'RATING' | 'RATING_SEED' | other
      'dupr_id', 'name',
      'client_id_match',       // TRUE if payload clientId matched our clientKey
      'rating_doubles', 'rating_singles',
      'match_id',
      'applied_to_player_id',  // player_id we updated, if any
      'apply_status',           // 'applied' | 'skipped_no_match' | 'rejected_bad_client'
      'raw_payload',           // truncated to 4KB
    ],
  },
};

const TAB_ORDER = ['Players', 'Games', 'DUPR_Push_Log', 'Admin_Sessions', 'Audit_Log', 'Webhook_Log'];
