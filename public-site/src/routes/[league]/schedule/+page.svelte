<script>
  import { onMount, getContext } from 'svelte';
  import { api } from '$lib/api.js';
  import { shortDate } from '$lib/format.js';

  const leagueStore = getContext('leagueStore');

  let weeks = [];
  let loading = true;
  let error = '';
  let lastLid = null;

  async function load(lid) {
    if (!lid || lid === lastLid) return;
    lastLid = lid;
    loading = true;
    error = '';
    try {
      const data = await api.schedule(lid);
      weeks = data.weeks || [];
    } catch (e) {
      error = e.message || String(e);
    } finally {
      loading = false;
    }
  }

  $: if ($leagueStore.league) load($leagueStore.league.league_id);
  $: leagueSlug = $leagueStore.league?.slug;
</script>

<svelte:head>
  <title>{$leagueStore.league?.name ?? 'League'} — Schedule</title>
</svelte:head>

<div class="section">
  {#if loading}
    <div class="loading">Loading schedule…</div>
  {:else if error}
    <div class="err">{error}</div>
  {:else if !weeks.length}
    <div class="empty">No schedule has been generated yet.</div>
  {:else}
    {#each weeks as wk}
      <div class="panel section-card">
        <div class="panel-h">
          <h3>Week {wk.week_number}{wk.play_date ? ' · ' + shortDate(wk.play_date) : ''}</h3>
          <span class="pill">{wk.matches.length} match{wk.matches.length === 1 ? '' : 'es'}{wk.skip ? ' (skip)' : ''}</span>
        </div>
        {#if !wk.matches.length}
          <div style="padding:16px; color: var(--text-muted); font-size: 13px;">No matches.</div>
        {:else}
          <table>
            <thead>
              <tr>
                <th class="c">Round</th>
                <th class="c">Court</th>
                <th>Team 1</th>
                <th class="c">Score</th>
                <th>Team 2</th>
              </tr>
            </thead>
            <tbody>
              {#each wk.matches as m}
                <tr>
                  <td class="c muted">{m.round}</td>
                  <td class="c muted">{m.court ?? '—'}</td>
                  <td class="team-cell">
                    {#if m.t1_team_id}
                      <a href="/{leagueSlug}/teams/{m.t1_team_id}">{m.t1_name}</a>
                    {:else}
                      {m.t1_name}
                    {/if}
                  </td>
                  <td class="c">
                    {#if m.played}
                      <span class="score" class:score-win={m.t1_score > m.t2_score} class:score-loss={m.t1_score < m.t2_score}>{m.t1_score}</span>
                      <span class="muted"> – </span>
                      <span class="score" class:score-win={m.t2_score > m.t1_score} class:score-loss={m.t2_score < m.t1_score}>{m.t2_score}</span>
                    {:else}
                      <span class="pill-badge scheduled">Scheduled</span>
                    {/if}
                  </td>
                  <td class="team-cell">
                    {#if m.t2_team_id}
                      <a href="/{leagueSlug}/teams/{m.t2_team_id}">{m.t2_name}</a>
                    {:else}
                      {m.t2_name}
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
    {/each}
  {/if}
</div>
