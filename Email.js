/**
 * Bulk emailing players in a league. Each send is logged to Email_Log so
 * we have an audit of communications.
 *
 * Uses MailApp (simpler than GmailApp; sender is the script owner, daily
 * quota is ~100 for personal, 1500 for Workspace).
 */

/**
 * @param {Object} input
 *   league_id           — filter recipients to this league's roster
 *   subject             — email subject (interpolated)
 *   body                — email body  (interpolated)
 *   include_inactive    — also email roster_status='inactive' (default false)
 *   to_player_ids       — optional explicit list (overrides league filter)
 *   dry_run             — if true, returns what WOULD be sent without sending
 *
 * Body/subject support {{full_name}}, {{first_name}}, {{league_name}} placeholders.
 *
 * @returns {{ recipients, sent, failed, errors, sample }}
 */
function bulkEmailLeague_(input) {
  if (!input.subject) throw new Error('subject required');
  if (!input.body) throw new Error('body required');

  let recipients;
  if (input.to_player_ids && input.to_player_ids.length) {
    const players = getObjects_('Players');
    const byId = {};
    players.forEach(p => { byId[p.player_id] = p; });
    recipients = input.to_player_ids.map(id => byId[id]).filter(Boolean);
  } else {
    if (!input.league_id) throw new Error('league_id or to_player_ids required');
    recipients = listRoster_(input.league_id, { includeInactive: !!input.include_inactive });
  }

  const league = input.league_id ? getLeagueById_(input.league_id) : null;
  const stamp = nowStamp_();
  const me = activeUserEmail_();

  const interpolate = (tmpl, p) => String(tmpl)
    .replace(/\{\{full_name\}\}/g,    p.full_name || '')
    .replace(/\{\{first_name\}\}/g,   p.first_name || (p.full_name || '').split(' ')[0] || '')
    .replace(/\{\{league_name\}\}/g,  league ? league.name : '')
    .replace(/\{\{league_full_name\}\}/g, league ? league.full_name : '');

  const sample = recipients.slice(0, 3).map(p => ({
    to: p.email,
    subject: interpolate(input.subject, p),
    body:    interpolate(input.body, p).slice(0, 200),
  }));

  if (input.dry_run) {
    return { recipients: recipients.length, sent: 0, failed: 0, errors: [], sample, dry_run: true };
  }

  let sent = 0, failed = 0;
  const errors = [];
  recipients.forEach(p => {
    if (!p.email) { failed++; errors.push((p.full_name || p.player_id) + ': no email'); return; }
    try {
      MailApp.sendEmail({
        to: p.email,
        subject: interpolate(input.subject, p),
        body:    interpolate(input.body, p),
      });
      sent++;
      appendObjects_('Email_Log', [{
        email_id:      makeId_('email'),
        sent_at:       stamp,
        sent_by:       me,
        recipients:    p.email,
        subject:       interpolate(input.subject, p),
        template_id:   '',
        league_id:     input.league_id || '',
        success:       true,
        error_message: '',
      }]);
    } catch (e) {
      failed++;
      const msg = String(e && e.message || e);
      errors.push((p.full_name || p.player_id) + ': ' + msg);
      appendObjects_('Email_Log', [{
        email_id:      makeId_('email'),
        sent_at:       stamp,
        sent_by:       me,
        recipients:    p.email || '',
        subject:       interpolate(input.subject, p),
        template_id:   '',
        league_id:     input.league_id || '',
        success:       false,
        error_message: msg,
      }]);
    }
  });

  audit_('bulk_email', 'league', input.league_id || '', null,
    { recipients: recipients.length, sent, failed });

  return { recipients: recipients.length, sent, failed, errors, sample, dry_run: false };
}
