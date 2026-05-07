/**
 * Substitution recording.
 *
 * A sub is an admin-recorded swap: a player on the roster is absent for
 * a given week and another player fills in. Mirrors the existing
 * "Subs Log" tab from your current admin sheet.
 *
 * Optionally sends a notification email to the substitute (and CC the
 * absent player) — controlled by `send_email` flag.
 */

/**
 * @param {Object} input
 *   league_id, play_date, week_number,
 *   absent_player_id, substitute_player_id,
 *   notes (optional), send_email (optional)
 */
function recordSubstitution_(input) {
  const errs = [];
  if (!input.league_id) errs.push('league_id required');
  if (!input.absent_player_id) errs.push('absent_player_id required');
  // When the sub came from CourtReserve attendance and isn't on any roster,
  // the operator only has a name (and optional CR member number). Auto-create
  // a guest Players row in that case so the Substitutions row can reference
  // a real player_id.
  if (!input.substitute_player_id && !String(input.substitute_full_name || '').trim()) {
    errs.push('substitute_player_id or substitute_full_name required');
  }
  if (errs.length) throw new Error(errs.join('; '));

  let subPlayerId = input.substitute_player_id;
  if (!subPlayerId) {
    const guest = upsertGuestPlayer_({
      full_name:     input.substitute_full_name,
      member_number: input.substitute_member_number,
    });
    subPlayerId = guest.player_id;
  }

  const players = getObjects_('Players');
  const absent = players.find(p => p.player_id === input.absent_player_id);
  const sub    = players.find(p => p.player_id === subPlayerId);
  if (!absent) throw new Error('absent player not found');
  if (!sub)    throw new Error('substitute player not found');

  const league = getLeagueById_(input.league_id);

  const sub_id = makeId_('sub');
  const stamp = nowStamp_();
  const me = activeUserEmail_();

  let emailSent = false, emailErr = '';
  if (input.send_email) {
    try {
      const subject = (league ? league.name + ' — ' : '') +
        'Sub for ' + absent.full_name + ' on ' + (input.play_date || '');
      const body =
        'Hi ' + (sub.first_name || sub.full_name || '') + ',\n\n' +
        'You are subbing for ' + absent.full_name + ' in ' +
        (league ? league.name : 'the league') +
        ' on ' + (input.play_date || '(date)') + '.\n\n' +
        (input.notes ? 'Notes: ' + input.notes + '\n\n' : '') +
        '— Dill Dinkers';
      MailApp.sendEmail({
        to: sub.email,
        cc: absent.email || '',
        subject: subject,
        body: body,
      });
      emailSent = true;
    } catch (e) {
      emailErr = String(e && e.message || e);
    }
  }

  appendObjects_('Substitutions', [{
    sub_id:                  sub_id,
    league_id:               input.league_id,
    play_date:               input.play_date || '',
    week_number:             input.week_number || '',
    absent_player_id:        absent.player_id,
    absent_player_name:      absent.full_name,
    substitute_player_id:    sub.player_id,
    substitute_player_name:  sub.full_name,
    recorded_by:             me,
    recorded_at:             stamp,
    email_sent:              emailSent,
    notes:                   input.notes || (emailErr ? 'email error: ' + emailErr : ''),
  }]);

  audit_('sub_record', 'sub', sub_id, null,
    { league_id: input.league_id, absent: absent.full_name, sub: sub.full_name });

  return { sub_id, email_sent: emailSent, email_error: emailErr };
}

/**
 * Delete a Substitution row by sub_id. Used to unpair a sub-with-no-show
 * mapping. Returns { deleted: true|false }.
 */
function voidSubstitution_(sub_id) {
  if (!sub_id) throw new Error('sub_id required');
  const all = getObjects_('Substitutions');
  const remain = all.filter(s => s.sub_id !== sub_id);
  if (remain.length === all.length) return { deleted: false };
  const removed = all.find(s => s.sub_id === sub_id);
  overwriteObjects_('Substitutions', remain);
  audit_('sub_void', 'sub', sub_id, removed || null, null);
  return { deleted: true };
}

function listSubstitutions_(filter) {
  const all = getObjects_('Substitutions');
  if (!filter) return all;
  return all.filter(s => Object.keys(filter).every(k => String(s[k]) === String(filter[k])));
}
