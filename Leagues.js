/**
 * League CRUD + week-schedule generation.
 *
 * A "league" is a single Mar/Apr 2026-style cohort: one format, one day,
 * one time, one set of weeks. Different seasons of the same league =
 * different rows (use season_label to distinguish).
 */

const VALID_FORMATS = ['ladder', 'partner'];
const VALID_STATUSES = ['draft', 'active', 'completed', 'archived'];

/**
 * Create a league + its week schedule in one call.
 *
 * @param {Object} input
 *   name           — short label, e.g. "Mon Intermediate Coed Ladder"
 *   full_name      — long label with level info
 *   format_type    — 'ladder' or 'partner'
 *   day_of_week    — 'Monday' .. 'Sunday'
 *   start_time     — display string, e.g. "8:15p - 10p"
 *   level          — display string, e.g. "Levels 4-6"
 *   season_label   — e.g. "Mar/Apr 2026"
 *   weeks          — array of { week_starts, week_ends, play_date, skip? }
 *                    OR a number; if number, schedule must be set later
 *   status         — defaults to 'draft'
 * @returns the created league object (with league_id)
 */
function createLeague_(input) {
  const errs = [];
  if (!input.name) errs.push('name required');
  if (!input.full_name) input.full_name = input.name;
  if (VALID_FORMATS.indexOf(input.format_type) === -1) errs.push('format_type must be one of ' + VALID_FORMATS.join('|'));
  if (!input.day_of_week) errs.push('day_of_week required');
  if (errs.length) throw new Error(errs.join('; '));

  const weeks = Array.isArray(input.weeks) ? input.weeks : [];
  const weeksCount = Array.isArray(input.weeks) ? input.weeks.length : (input.weeks || CONFIG.DEFAULT_WEEKS);

  const stamp = nowStamp_();
  const me = activeUserEmail_();
  const league_id = makeId_('league');

  appendObjects_('Leagues', [{
    league_id:         league_id,
    name:              input.name,
    full_name:         input.full_name,
    format_type:       input.format_type,
    day_of_week:       input.day_of_week,
    start_time:        input.start_time || '',
    level:             input.level || '',
    season_label:      input.season_label || '',
    weeks_count:       weeksCount,
    num_groups:        input.num_groups || '',
    bonus_starts_week: input.bonus_starts_week || 3,
    status:            input.status || 'draft',
    created_at:        stamp,
    created_by:        me,
  }]);

  // For ladder format, seed the standard Bonus_Config so standings work
  // out of the box. Operator can override later via Bonus_Config rows.
  if (input.format_type === 'ladder' && input.num_groups) {
    seedBonusConfigStandard_(league_id, input.num_groups);
  }

  if (weeks.length) {
    const rows = weeks.map((w, i) => ({
      schedule_id:  makeId_('schedule'),
      league_id:    league_id,
      week_number:  i + 1,
      week_starts:  w.week_starts || '',
      week_ends:    w.week_ends   || '',
      play_date:    w.play_date   || '',
      skip_week:    !!w.skip,
      notes:        w.notes || '',
    }));
    appendObjects_('League_Schedule', rows);
  }

  audit_('league_create', 'league', league_id, null, { name: input.name, format_type: input.format_type });
  return getLeagueById_(league_id);
}

/** Convenience: list every league, newest-first. */
function listLeagues_(filter) {
  const all = getObjects_('Leagues');
  if (!filter) return all;
  return all.filter(l => Object.keys(filter).every(k => l[k] === filter[k]));
}

function getLeagueById_(league_id) {
  return getObjects_('Leagues').find(l => l.league_id === league_id) || null;
}

function getLeagueSchedule_(league_id) {
  return getObjects_('League_Schedule')
    .filter(s => s.league_id === league_id)
    .sort((a, b) => Number(a.week_number) - Number(b.week_number));
}

function setLeagueStatus_(league_id, status) {
  if (VALID_STATUSES.indexOf(status) === -1) throw new Error('Invalid status: ' + status);
  const before = getLeagueById_(league_id);
  if (!before) throw new Error('League not found: ' + league_id);
  updateWhere_('Leagues', l => l.league_id === league_id, l => { l.status = status; });
  audit_('league_status', 'league', league_id, before.status, status);
}
