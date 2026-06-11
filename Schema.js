/**
 * Master Sheet schema — every tab name and its column order.
 *
 * Bootstrap.js reads this to create tabs and write headers. Utils.js reads
 * it to map column-name <-> column-index. To add a column, append it here
 * and re-run bootstrap (the bootstrap is idempotent and additive — it never
 * removes columns).
 *
 * Each table has:
 *   columns: ordered list of column names (header row)
 *   notes:   one-line purpose
 */
const SCHEMA = {

  Config: {
    notes: 'Key/value app settings.',
    columns: ['key', 'value', 'updated_at', 'updated_by'],
  },

  Roles: {
    notes: 'Who can do what. role in {admin, operator, captain}. scope optional.',
    columns: ['email', 'role', 'scope_league_id', 'scope_team_id', 'active', 'notes', 'created_at'],
  },

  Leagues: {
    notes: 'League registry. format_type in {ladder, partner}. cr_event_id links to a CourtReserve event when populated from /eventcalendar/eventlist.',
    columns: [
      'league_id', 'name', 'full_name', 'format_type', 'day_of_week',
      'start_time', 'level', 'season_label', 'weeks_count', 'num_groups',
      'bonus_starts_week', 'status', 'created_at', 'created_by',
      'cr_event_id', 'cr_category_id', 'cr_event_start', 'cr_event_end',
    ],
  },

  League_Schedule: {
    notes: 'Per-league week list (week_number, dates, optional skip flag).',
    columns: [
      'schedule_id', 'league_id', 'week_number', 'week_starts', 'week_ends',
      'play_date', 'skip_week', 'notes',
    ],
  },

  Match_Schedule: {
    notes: 'Partner-only: pre-generated team-vs-team matchups. game_id filled when played.',
    columns: [
      'match_id', 'league_id', 'week_number', 'game_number', 'court_number',
      't1_team_id', 't2_team_id', 'play_date', 'game_id',
    ],
  },

  Players: {
    notes: 'Master roster of every person ever registered.',
    columns: [
      'player_id', 'full_name', 'display_name', 'first_name', 'last_name',
      'email', 'phone', 'gender', 'dupr_id', 'club_member_id', 'level',
      'active', 'notes', 'is_guest', 'created_at',
    ],
  },

  Rosters: {
    notes: 'Approved players in a league. team_id null for ladder format.',
    columns: [
      'roster_id', 'league_id', 'player_id', 'team_id', 'level', 'status',
      'added_at', 'added_by',
    ],
  },

  Teams: {
    notes: 'Partner-only: a team is two players with a shared name.',
    columns: ['team_id', 'league_id', 'team_name', 'player_1_id', 'player_2_id', 'created_at'],
  },

  Session_Groups: {
    notes: 'Ladder-only: which group a player is in for a given week + half. half in {1,2}; half 1 seeded from season standings, half 2 from the halftime mix. Empty half = legacy data, treated as half 1.',
    columns: [
      'session_group_id', 'league_id', 'week_number', 'group_number',
      'player_id', 'starting_slot', 'created_at', 'half',
      'original_player_id',
    ],
  },

  Session_Game_Overrides: {
    notes: 'Ladder-only: per-game player swaps that override Session_Groups for a single game_in_match. Used when a sub plays one game but not the whole match.',
    columns: [
      'override_id', 'league_id', 'week_number', 'half',
      'group_number', 'game_in_match', 'starting_slot',
      'original_player_id', 'player_id',
      'created_at', 'created_by',
    ],
  },

  Games: {
    notes: 'The source of truth — every game played. status in {open, complete, voided}. half in {1,2} for ladder session games; empty for other game types.',
    columns: [
      'game_id', 'league_id', 'week_number', 'round_number', 'group_number',
      'match_number', 'game_in_match', 'court_number', 'play_date',
      't1_team_id', 't1_player_1_id', 't1_player_2_id',
      't2_team_id', 't2_player_1_id', 't2_player_2_id',
      't1_score', 't2_score', 'winner', 'status',
      'entered_by', 'entered_at', 'updated_at', 'notes', 'half',
    ],
  },

  Substitutions: {
    notes: 'Sub log per league.',
    columns: [
      'sub_id', 'league_id', 'play_date', 'week_number',
      'absent_player_id', 'absent_player_name',
      'substitute_player_id', 'substitute_player_name',
      'recorded_by', 'recorded_at', 'email_sent', 'notes',
    ],
  },

  DUPR: {
    notes: 'Cached doubles ratings. Refreshed periodically from DUPR.',
    columns: [
      'dupr_id', 'name', 'doubles_rating', 'reliability_pct',
      'club_member_number', 'last_synced_at',
    ],
  },

  Email_Log: {
    notes: 'Outbound email history.',
    columns: [
      'email_id', 'sent_at', 'sent_by', 'recipients', 'subject',
      'template_id', 'league_id', 'success', 'error_message',
    ],
  },

  Audit_Log: {
    notes: 'Change history for sensitive entities.',
    columns: [
      'audit_id', 'timestamp', 'actor_email', 'action', 'entity_type',
      'entity_id', 'old_value', 'new_value',
    ],
  },

  Bonus_Config: {
    notes: 'Per-league bonus multipliers (ladder format). One row per group_rank. W bonus only counts on wins; P bonus counts on every qualifying game.',
    columns: [
      'league_id', 'group_rank', 'w_multiplier_per_win',
      'p_multiplier_per_game', 'notes',
    ],
  },

  CR_Sync_Log: {
    notes: 'CourtReserve API call/sync history. status in {ok, error, rate_limited}.',
    columns: [
      'sync_id', 'started_at', 'finished_at', 'actor_email', 'kind',
      'method', 'path', 'http_status', 'count', 'status', 'message',
    ],
  },

  CR_Registrations: {
    notes: 'Staging table for CourtReserve event registrations. Pulled from /api/v1/eventregistrationreport/listactive. Filter and bulk-assign rows to a league via the Integrations tab. Dedup key: (cr_member_id|email) + cr_event_id + signed_up_on_date.',
    columns: [
      'cr_reg_id', 'imported_at',
      'cr_event_id', 'event_name',
      'cr_category_id', 'category_name',
      'cr_event_date_id', 'event_start', 'event_end',
      'registration_type',
      'is_team_event', 'cr_member_id',
      'first_name', 'last_name', 'email', 'phone',
      'partners_json',
      'price_to_pay', 'paid_amount',
      'unsub_marketing_email', 'unsub_marketing_text',
      'courts_json', 'user_defined_fields_json', 'raw_json',
      'signed_up_on', 'cancelled_on', 'status',
      'assigned_league_id', 'assigned_team_id', 'assigned_player_id', 'assigned_at',
    ],
  },

  CR_Members: {
    notes: 'CourtReserve member directory. Pulled from the members API. Dedup key: cr_member_id (OrganizationMemberId). MembershipNumber bridges to CR_Attendance.member_number.',
    columns: [
      'cr_member_id', 'membership_number', 'imported_at',
      'first_name', 'last_name', 'email', 'phone', 'gender',
      'date_of_birth',
      'membership_type', 'membership_type_id', 'membership_status',
      'membership_assignment_type',
      'membership_start', 'membership_end',
      'family_id', 'family_role', 'allow_child_login',
      'address', 'city', 'state', 'zip',
      'unsub_marketing_email', 'unsub_marketing_push',
      'unsub_marketing_text', 'unsub_org_text',
      'external_id', 'udf_json', 'raw_json',
    ],
  },

  Player_DUPR_Overrides: {
    notes: 'Per-player DUPR ID, keyed by cr_member_id or email. Survives CR re-pulls.',
    columns: ['key', 'cr_member_id', 'email', 'dupr_id', 'updated_at', 'updated_by'],
  },

  Team_Name_Overrides: {
    notes: 'Custom team names per CR registration. Keyed by cr_reg_id.',
    columns: ['cr_reg_id', 'team_name', 'updated_at', 'updated_by'],
  },

  Team_Pairings: {
    notes: 'Manual team pairings — two players (by CR member_number) make a team in a league. Used for partner-format leagues built from attendance.',
    columns: ['pairing_id', 'league_id', 'p1_member_id', 'p2_member_id', 'team_name', 'created_at', 'created_by'],
  },

  CR_Attendance: {
    notes: 'CourtReserve check-in / no-show records. Pulled from /api/v1/attendancereport/checkin. Dedup key: member_number + event_name + reservation_start.',
    columns: [
      'attendance_id', 'imported_at',
      'member_number', 'first_name', 'last_name',
      'event_name',
      'check_in_status',
      'check_in_type', 'checkin_datetime', 'checked_in_by',
      'registration_type',
      'reservation_start', 'reservation_end', 'reservation_display',
      'registered_on_display',
      'is_guest', 'type',
    ],
  },

};

const TABLE_ORDER = [
  'Config', 'Roles',
  'Leagues', 'League_Schedule', 'Match_Schedule',
  'Players', 'Rosters', 'Teams', 'Session_Groups', 'Session_Game_Overrides',
  'Games', 'Substitutions',
  'DUPR', 'Email_Log', 'Audit_Log', 'Bonus_Config',
  'CR_Sync_Log', 'CR_Registrations', 'CR_Attendance', 'CR_Members',
  'Player_DUPR_Overrides', 'Team_Name_Overrides', 'Team_Pairings',
];
