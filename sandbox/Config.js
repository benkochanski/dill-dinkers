/**
 * Sandbox configuration.
 *
 * Sheet ID lives in Script Properties (SANDBOX_SHEET_ID) so this file can be
 * committed without exposing the target spreadsheet. Set it via the Apps
 * Script editor → Project Settings → Script Properties before running
 * bootstrap().
 */

const CONFIG = {
  APP_NAME:  'Dill Dinkers — Sandbox',
  TIMEZONE:  'America/New_York',
  ID_PREFIX: {
    player:   'P',
    game:     'G',
    audit:    'AUD',
    session:  'SES',
    push:     'PUSH',
  },
};

function getMasterSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SANDBOX_SHEET_ID');
  if (!id) throw new Error('SANDBOX_SHEET_ID not set in Script Properties.');
  return SpreadsheetApp.openById(id);
}
