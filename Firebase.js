/**
 * Firebase Realtime Database publisher.
 *
 * Bolts a realtime push layer onto the existing app without changing where
 * data lives — the Google Sheet is still source of truth. Every mutation
 * that bumps a league's version also fans the new payload out to RTDB so
 * Display clients (and anyone else subscribed) get a WebSocket push in
 * 50-150ms instead of waiting on a 1.5s poll.
 *
 * Configuration via Script Properties:
 *   FIREBASE_DB_URL    e.g. https://dill-dinkers-live-default-rtdb.firebaseio.com
 *   FIREBASE_SECRET    legacy database secret (Project Settings → Service
 *                      accounts → Database secrets)
 *
 * If either property is missing, publishToFirebase_() is a silent no-op —
 * the app continues to work exactly as before, just without realtime push.
 */

function _firebaseConfig_() {
  const props = PropertiesService.getScriptProperties();
  const url = (props.getProperty('FIREBASE_DB_URL') || '').replace(/\/+$/, '');
  const secret = props.getProperty('FIREBASE_SECRET') || '';
  return { url: url, secret: secret };
}

function firebaseConfigured_() {
  const c = _firebaseConfig_();
  return !!(c.url && c.secret);
}

/**
 * Write `payload` to Firebase RTDB at `path` (no leading slash needed).
 * Uses PUT — replaces the node entirely. Use this when the payload is the
 * full picture for that subtree.
 */
function publishToFirebase_(path, payload) {
  const cfg = _firebaseConfig_();
  if (!cfg.url || !cfg.secret) return false;
  const fullUrl = cfg.url + '/' + String(path).replace(/^\/+/, '') +
    '.json?auth=' + encodeURIComponent(cfg.secret);
  try {
    const resp = UrlFetchApp.fetch(fullUrl, {
      method: 'put',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    const code = resp.getResponseCode();
    if (code >= 200 && code < 300) return true;
    console.warn('firebase publish ' + code + ': ' + resp.getContentText().slice(0, 200));
    return false;
  } catch (e) {
    console.warn('firebase publish error: ' + (e && e.message || e));
    return false;
  }
}

/**
 * Best-effort: publish the league's current state (version + week/half/courts).
 * Cheap — just a few fields, no sheet reads beyond what getLeagueState_
 * already needs. Called from bumpLeagueVersion_ + setActiveHalf_.
 */
function publishLeagueState_(league_id) {
  if (!league_id || !firebaseConfigured_()) return;
  try {
    const state = _readLeagueState_(league_id);
    publishToFirebase_('leagues/' + league_id + '/state', {
      version:    state.version,
      week:       state.week,
      half:       state.half,
      courts:     state.courts || [],
      updated_at: new Date().toISOString(),
    });
  } catch (e) { /* swallow — never break a write because Firebase is flaky */ }
}

/**
 * Publish a full Display-render bundle for a ladder league. Called by
 * api_publishLeagueSnapshot — typically right after a save, so all Display
 * subscribers get the new session + standings pushed without re-fetching.
 */
function publishLadderSnapshot_(league_id, week_number, half, court_numbers) {
  if (!league_id || !firebaseConfigured_()) return;
  try {
    const session    = getSession_(league_id, week_number, half, court_numbers || []);
    const standings  = recomputeStandings_(league_id);
    const day        = computeDayStandings_(league_id, week_number);
    publishToFirebase_('leagues/' + league_id + '/snapshot', {
      kind:           'ladder',
      week:           Number(week_number),
      half:           Number(half),
      session:        session,
      standings:      standings,
      day_standings:  day,
      updated_at:     new Date().toISOString(),
    });
  } catch (e) {
    console.warn('publishLadderSnapshot_ error: ' + (e && e.message || e));
  }
}

function publishPartnerSnapshot_(league_id, week_number) {
  if (!league_id || !firebaseConfigured_()) return;
  try {
    const week_view = getPartnerWeekView_(league_id, week_number);
    const standings = recomputeStandings_(league_id);
    publishToFirebase_('leagues/' + league_id + '/snapshot', {
      kind:        'partner',
      week:        Number(week_number),
      week_view:   week_view,
      standings:   standings,
      updated_at:  new Date().toISOString(),
    });
  } catch (e) {
    console.warn('publishPartnerSnapshot_ error: ' + (e && e.message || e));
  }
}
