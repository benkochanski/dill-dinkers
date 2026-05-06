<script>
  import { getContext } from 'svelte';
  import { page } from '$app/stores';
  import { api } from '$lib/api.js';
  import { wl, plusMinus, shortDate } from '$lib/format.js';

  const leagueStore = getContext('leagueStore');

  let detail = null;
  let loading = true;
  let error = '';
  let lastKey = null;

  async function load(lid, tid) {
    if (!lid || !tid) return;
    const key = lid + '|' + tid;
    if (key === lastKey) return;
    lastKey = key;
    loading = true;
    error = '';
    try {
      detail = await api.team(lid, tid);
    } catch (e) {
      error = e.message || String(e);
    } finally {
      loading = false;
    }
  }

  $: tid = $page.params.team;
  $: if ($leagueStore.league && tid) load($leagueStore.league.league_id, tid);
  $: leagueSlug = $leagueStore.league?.slug;

  $: byWeek = (() => {
    if (!detail) return new Map();
    const out = new Map();
    for (const s of detail.schedule || []) {
      if (!out.has(s.week)) out.set(s.week, []);
      out.get(s.week).push(s);
    }
    return out;
  })();
</script>

<svelte:head>
  <title>{detail?.team?.team_name ?? 'Team'} — {$leagueStore.league?.name ?? ''}</title>
</svelte:head>

<div class="section">
  {#if loading}
    <div class="loading">Loading team…</div>
  {:else if error}
    <div class="err">{error}</div>
  {:else if detail}
    <!-- Team header card -->
    <div class="panel section-card">
      <div class="panel-h">
        <h3>Team Profile</h3>
        {#if detail.standing?.rank}
          <span class="pill">Rank #{detail.standing.rank}</span>
        {/if}
      </div>
      <div style="padding: 20px 24px;">
        <div style="display: flex; align-items: baseline; gap: 18px; flex-wrap: wrap;">
          <h2 style="margin:0; font-size: 28px; font-weight: 900; letter-spacing: -0.025em;">{detail.team.team_name}</h2>
          <div style="color: var(--text-muted); font-size: 14px;">
            {[detail.team.player_1_name, detail.team.player_2_name].filter(Boolean).join(' · ') || '—'}
          </div>
        </div>
        {#if detail.standing}
          <div style="margin-top: 18px; display: flex; gap: 24px; flex-wrap: wrap;">
            <div>
              <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--text-dim); font-weight: 700;">Record</div>
              <div class="num" style="font-size: 22px; font-weight: 800; margin-top: 2px;">{wl(detail.standing.wins, detail.standing.losses)}</div>
            </div>
            <div>
              <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--text-dim); font-weight: 700;">Games Back</div>
              <div class="num" style="font-size: 22px; font-weight: 800; margin-top: 2px;">{detail.standing.games_back > 0 ? detail.standing.games_back.toFixed(1) : '—'}</div>
            </div>
            <div>
              <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--text-dim); font-weight: 700;">Point Diff</div>
              <div class="num {detail.standing.point_diff > 0 ? 'pos' : detail.standing.point_diff < 0 ? 'neg' : ''}" style="font-size: 22px; font-weight: 800; margin-top: 2px;">{plusMinus(detail.standing.point_diff)}</div>
            </div>
            <div>
              <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--text-dim); font-weight: 700;">Pts For / Against</div>
              <div class="num" style="font-size: 22px; font-weight: 800; margin-top: 2px;">{detail.standing.points_for} / {detail.standing.points_against}</div>
            </div>
          </div>
        {/if}
      </div>
    </div>

    <!-- Schedule + Results -->
    <div class="panel section-card">
      <div class="panel-h"><h3>Schedule &amp; Results</h3><span class="pill">{detail.schedule?.length || 0} matches</span></div>
      {#if !byWeek.size}
        <div style="padding:16px; color: var(--text-muted);">No matches scheduled.</div>
      {:else}
        {#each [...byWeek.entries()] as [week, matches]}
          <div style="padding: 14px 16px 4px; background: var(--bg-elev); border-bottom: 1px solid var(--border); font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.12em; color: var(--text-muted);">
            Week {week}{matches[0]?.play_date ? ' · ' + shortDate(matches[0].play_date) : ''}
          </div>
          <table>
            <thead>
              <tr>
                <th class="c">R</th>
                <th class="c">Court</th>
                <th>Opponent</th>
                <th>Lineup (us / them)</th>
                <th class="c">Result</th>
              </tr>
            </thead>
            <tbody>
              {#each matches as m}
                <tr>
                  <td class="c muted">{m.round}</td>
                  <td class="c muted">{m.court ?? '—'}</td>
                  <td>
                    <div class="team-cell"><a href="/{leagueSlug}/teams/{m.opponent_id}">{m.opponent_name}</a></div>
                  </td>
                  <td>
                    {#if m.played}
                      <div class="team-sub">
                        <strong style="color: var(--text);">{(m.my_players || []).join(' · ') || '—'}</strong>
                      </div>
                      <div class="team-sub">vs {(m.opp_players || []).join(' · ') || '—'}</div>
                    {:else}
                      <div class="team-sub muted">—</div>
                    {/if}
                  </td>
                  <td class="c">
                    {#if m.played}
                      <span class="pill-badge {m.won ? 'win' : 'loss'}" style="margin-right:6px;">
                        {m.won ? 'W' : 'L'}
                      </span>
                      <span class="score" class:score-win={m.won} class:score-loss={!m.won}>{m.my_score}–{m.opp_score}</span>
                    {:else}
                      <span class="pill-badge scheduled">Scheduled</span>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/each}
      {/if}
    </div>

    <!-- Head-to-head -->
    <div class="panel section-card">
      <div class="panel-h"><h3>Head-to-Head</h3><span class="pill">vs every team</span></div>
      <table>
        <thead>
          <tr>
            <th>Opponent</th>
            <th class="r">W–L</th>
            <th class="r">Pts For</th>
            <th class="r">Pts Against</th>
            <th class="r">+/−</th>
            <th class="r">Remaining</th>
          </tr>
        </thead>
        <tbody>
          {#each detail.h2h as h}
            {@const diff = h.points_for - h.points_against}
            <tr class="row-link" on:click={() => location.href = `/${leagueSlug}/teams/${h.opponent_id}`}>
              <td class="team-cell"><a href="/{leagueSlug}/teams/{h.opponent_id}">{h.opponent_name}</a></td>
              <td class="r wl">{wl(h.wins, h.losses)}</td>
              <td class="r num">{h.points_for}</td>
              <td class="r num">{h.points_against}</td>
              <td class="r {diff > 0 ? 'pos' : diff < 0 ? 'neg' : ''}">{plusMinus(diff)}</td>
              <td class="r num">{h.remaining}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <!-- Sub history -->
    {#if detail.subs?.length}
      <div class="panel section-card">
        <div class="panel-h"><h3>Substitution History</h3><span class="pill">{detail.subs.length} total</span></div>
        <table>
          <thead>
            <tr>
              <th class="c">Week</th>
              <th>Date</th>
              <th>Direction</th>
              <th>Player Out</th>
              <th>Sub In</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {#each detail.subs as s}
              <tr>
                <td class="c muted">{s.week ?? '—'}</td>
                <td class="muted">{s.play_date ? shortDate(s.play_date) : '—'}</td>
                <td>
                  <span class="pill-badge {s.direction === 'in' ? 'scheduled' : 'loss'}">
                    {s.direction === 'in' ? 'Subbed FOR another team' : 'Sub for our team'}
                  </span>
                </td>
                <td>{s.absent_name || '—'}</td>
                <td>{s.substitute_name || '—'}</td>
                <td class="muted">{s.notes || ''}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
</div>
