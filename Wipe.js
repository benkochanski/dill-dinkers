/**
 * Destructive: wipes all application data. Run from the Apps Script editor.
 *
 * What it clears (data rows only — headers preserved):
 *   Leagues, League_Schedule, Match_Schedule, Players, Rosters, Teams,
 *   Session_Groups, Games, Substitutions, DUPR, Email_Log, Audit_Log,
 *   Bonus_Config, CR_Sync_Log
 *
 * What it KEEPS:
 *   - Config tab (app-level settings)
 *   - The running user's admin row in Roles (so you don't lock yourself out).
 *     All other Roles rows are cleared.
 *   - Script Properties (CourtReserve credentials, etc.) — infrastructure,
 *     not application data.
 *
 * Recovery: every change is in Google Drive's version history for the master
 * sheet — File → Version history → See version history. So this is reversible
 * if you change your mind.
 *
 * To run:
 *   1. Open the Apps Script editor (script.google.com/d/<scriptId>/edit)
 *   2. Pick `wipeAllData` from the function dropdown
 *   3. Click Run, accept any auth prompt
 *   4. Check the execution log for a per-tab summary
 */
function wipeAllData() {
  const me = (activeUserEmail_() || '').toLowerCase().trim();
  const summary = [];

  // Tabs to clear (data rows only — headers stay).
  const TABS_TO_WIPE = [
    'Leagues', 'League_Schedule', 'Match_Schedule',
    'Players', 'Rosters', 'Teams', 'Session_Groups',
    'Games', 'Substitutions',
    'DUPR', 'Email_Log', 'Audit_Log', 'Bonus_Config',
    'CR_Sync_Log',
  ];

  TABS_TO_WIPE.forEach(name => {
    try {
      const before = getObjects_(name).length;
      overwriteObjects_(name, []);
      summary.push(name + ': cleared ' + before + ' row(s)');
    } catch (e) {
      // Tab may not exist if bootstrap hasn't been run with the latest schema.
      summary.push(name + ': skipped (' + (e && e.message || e) + ')');
    }
  });

  // Roles: keep just the running user's admin row(s). If they had none,
  // re-add one so they don't lock themselves out.
  const all = getObjects_('Roles');
  const myRows = all.filter(r =>
    String(r.email || '').toLowerCase().trim() === me &&
    r.role === 'admin' &&
    (r.active === true || String(r.active).toUpperCase() === 'TRUE')
  );
  if (myRows.length) {
    overwriteObjects_('Roles', myRows);
    summary.push('Roles: kept ' + myRows.length + ' admin row(s) for ' + me +
      ', cleared ' + (all.length - myRows.length) + ' other(s)');
  } else {
    overwriteObjects_('Roles', []);
    if (me) {
      appendObjects_('Roles', [{
        email:           me,
        role:            'admin',
        scope_league_id: '',
        scope_team_id:   '',
        active:          true,
        notes:           'Re-added by wipeAllData',
        created_at:      nowStamp_(),
      }]);
      summary.push('Roles: cleared all, re-added admin for ' + me);
    } else {
      summary.push('Roles: cleared all (could not detect running email — bootstrap escape hatch will let you back in)');
    }
  }

  cacheBustAll_();
  const message = summary.join('\n');
  Logger.log(message);
  return message;
}
