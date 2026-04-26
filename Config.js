/**
 * Application-level constants. Sheet IDs and other tunables live here so
 * they're easy to change in one place.
 */
const CONFIG = {
  MASTER_SHEET_ID: '19qEK8NA7s39So9zNhZOT99RUZcgBGlrdh9uKQVxBO0Q',
  APP_NAME: 'Dill Dinkers League Manager',
  DEFAULT_WEEKS: 8,
  TIMEZONE: 'America/New_York',
  ID_PREFIX: {
    league:       'L',
    player:       'P',
    team:         'T',
    game:         'G',
    roster:       'R',
    schedule:     'S',
    match:        'M',
    sub:          'X',
    email:        'E',
    audit:        'A',
    registration: 'N',
    session:      'Q',
  },
};

function getMasterSpreadsheet_() {
  return SpreadsheetApp.openById(CONFIG.MASTER_SHEET_ID);
}
