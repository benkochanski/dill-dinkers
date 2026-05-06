import { PUBLIC_API_BASE } from '$env/static/public';

if (!PUBLIC_API_BASE) {
  console.warn('PUBLIC_API_BASE is not set. Copy .env.example to .env and fill it in.');
}

/**
 * Apps Script JSON endpoint client.
 *
 * Apps Script `/exec` returns a 302 to script.googleusercontent.com which
 * serves the actual response. Browsers follow it automatically and the
 * downstream response includes Access-Control-Allow-Origin: * for anonymous
 * deployments, so a plain fetch from any domain works.
 */
async function call(action, params = {}) {
  const url = new URL(PUBLIC_API_BASE);
  url.searchParams.set('page', 'json');
  url.searchParams.set('action', action);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    method: 'GET',
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`API ${action} failed: HTTP ${res.status}`);
  const body = await res.json();
  if (!body.ok) throw new Error(body.error || 'Unknown API error');
  return body.data;
}

export const api = {
  leagues:   () => call('leagues'),
  league:    (lid) => call('league',    { lid }),
  standings: (lid) => call('standings', { lid }),
  schedule:  (lid) => call('schedule',  { lid }),
  results:   (lid) => call('results',   { lid }),
  teams:     (lid) => call('teams',     { lid }),
  team:      (lid, tid) => call('team', { lid, tid }),
};
