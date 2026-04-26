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
    notes: 'League registry. format_type in {ladder, partner}.',
    columns: [
      'league_id', 'name', 'full_name', 'format_type', 'day_of_week',
      'start_time', 'level', 'season_label', 'weeks_count', 'status',
      'created_at', 'created_by',
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
      'player_id', 'full_name', 'first_name', 'last_name', 'email', 'phone',
      'gender', 'dupr_id', 'club_member_id', 'level', 'active', 'notes',
      'created_at',
    ],
  },

  Registrations: {
    notes: 'Inbound registrations from external system. status in {pending, approved, rejected}.',
    columns: [
      'registration_id', 'league_full_name', 'member_number', 'member_email',
      'member_phone', 'full_name', 'club_level', 'dupr_id', 'partner_status',
      'partner_name', 'team_name', 'imported_at', 'status', 'league_id',
      'reviewed_by', 'reviewed_at',
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
    notes: 'Ladder-only: which group a player is in for a given week.',
    columns: [
      'session_group_id', 'league_id', 'week_number', 'group_number',
      'player_id', 'starting_slot', 'created_at',
    ],
  },

  Games: {
    notes: 'The source of truth — every game played. status in {open, complete, voided}.',
    columns: [
      'game_id', 'league_id', 'week_number', 'round_number', 'group_number',
      'match_number', 'game_in_match', 'court_number', 'play_date',
      't1_team_id', 't1_player_1_id', 't1_player_2_id',
      't2_team_id', 't2_player_1_id', 't2_player_2_id',
      't1_score', 't2_score', 'winner', 'status',
      'entered_by', 'entered_at', 'updated_at', 'notes',
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

};

const TABLE_ORDER = [
  'Config', 'Roles',
  'Leagues', 'League_Schedule', 'Match_Schedule',
  'Players', 'Registrations', 'Rosters', 'Teams', 'Session_Groups',
  'Games', 'Substitutions',
  'DUPR', 'Email_Log', 'Audit_Log',
];
