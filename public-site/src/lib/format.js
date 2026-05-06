/** Format a YYYY-MM-DD string as e.g. "Wed, May 6". */
export function shortDate(s) {
  if (!s) return '';
  const d = new Date(s + 'T12:00:00');
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/** "14–4" given (14, 4) */
export function wl(w, l) {
  return `${w ?? 0}–${l ?? 0}`;
}

/** "+38" / "−12" / "0" */
export function plusMinus(n) {
  if (n == null) return '0';
  if (n > 0) return '+' + n;
  if (n < 0) return '−' + Math.abs(n);
  return '0';
}

/** ".778" — 3-decimal pct WITHOUT leading zero, baseball-style. */
export function batPct(n) {
  if (n == null || isNaN(n)) return '.000';
  const v = n.toFixed(3);
  return v.startsWith('0') ? v.slice(1) : v;
}

/** "55.6%" */
export function pct(n) {
  if (n == null || isNaN(n)) return '0.0%';
  return (n * 100).toFixed(1) + '%';
}
