<script>
  import { onMount, getContext } from 'svelte';
  import { page } from '$app/stores';
  import { api } from '$lib/api.js';
  import { batPct, plusMinus, wl } from '$lib/format.js';

  const leagueStore = getContext('leagueStore');

  let standings = [];
  let weekly = null;
  let loading = true;
  let error = '';
  let lastLid = null;

  async function load(lid) {
    if (!lid || lid === lastLid) return;
    lastLid = lid;
    loading = true;
    error = '';
    try {
      const data = await api.standings(lid);
      standings = data.standings || [];
      weekly = data.weekly || null;
    } catch (e) {
      error = e.message || String(e);
    } finally {
      loading = false;
    }
  }

  $: if ($leagueStore.league) load($leagueStore.league.league_id);

  $: format = $leagueStore.league?.format_type;
  $: leagueSlug = $leagueStore.league?.slug;

  function rankCls(r) {
    if (r === 1) return 'rank-cell rank-1';
    if (r === 2 || r === 3) return 'rank-cell rank-2';
    return 'rank-cell';
  }
</script>

<svelte:head>
  <title>{$leagueStore.league?.name ?? 'League'} — Standings</title>
</svelte:head>

<div class="section">
  {#if loading}
    <div class="loading">Loading standings…</div>
  {:else if error}
    <div class="err">{error}</div>
  {:else if !standings.length}
    <div class="empty">No completed games yet — check back after the first session.</div>
  {:else if format === 'partner'}
    <div class="two-col">
      <div class="panel">
        <div class="panel-h"><h3>Season Standings</h3>
          {#if weekly?.weeks?.length}<span class="pill">Through Week {Math.max(...weekly.weeks)}</span>{/if}
        </div>
        <table>
          <thead>
            <tr>
              <th>#</th><th>Team</th>
              <th class="r">W–L</th><th class="r">PCT</th>
              <th class="r">GB</th><th class="r">+/−</th>
            </tr>
          </thead>
          <tbody>
            {#each standings as s}
              {@const totalGames = (s.wins || 0) + (s.losses || 0)}
              {@const pctVal = totalGames ? s.wins / totalGames : 0}
              <tr class="row-link" on:click={() => location.href = `/${leagueSlug}/teams/${s.team_id}`}>
                <td class={rankCls(s.rank)}>{s.rank}</td>
                <td>
                  <div class="team-cell"><a href="/{leagueSlug}/teams/{s.team_id}">{s.team_name}</a></div>
                  {#if s.player_1_name || s.player_2_name}
                    <div class="team-sub">{[s.player_1_name, s.player_2_name].filter(Boolean).join(' · ')}</div>
                  {/if}
                </td>
                <td class="r wl">{wl(s.wins, s.losses)}</td>
                <td class="r num">{batPct(pctVal)}</td>
                <td class="r num">{s.games_back > 0 ? s.games_back.toFixed(1) : '—'}</td>
                <td class="r {s.point_diff > 0 ? 'pos' : s.point_diff < 0 ? 'neg' : ''}">{plusMinus(s.point_diff)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      {#if weekly?.weeks?.length}
        <div class="panel">
          <div class="panel-h"><h3>Weekly Record</h3><span class="pill">W–L per session</span></div>
          <table class="weekly-table">
            <thead>
              <tr>
                <th>Team</th>
                {#each weekly.weeks as w}<th>W{w}</th>{/each}
              </tr>
            </thead>
            <tbody>
              {#each standings as s}
                <tr>
                  <td>{s.team_name}</td>
                  {#each weekly.by_team[s.team_id] || [] as wk}
                    {#if wk.w + wk.l === 0}
                      <td class="week-x">—</td>
                    {:else if wk.w >= wk.l}
                      <td class="week-w">{wk.w}–{wk.l}</td>
                    {:else}
                      <td class="week-l">{wk.w}–{wk.l}</td>
                    {/if}
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>
  {:else}
    <!-- Ladder -->
    <div class="panel">
      <div class="panel-h"><h3>Season Standings</h3><span class="pill">Composite Score</span></div>
      <table>
        <thead>
          <tr>
            <th>#</th><th>Player</th>
            <th class="r">W–L</th><th class="r">W%</th>
            <th class="r">P%</th><th class="r">Score</th>
          </tr>
        </thead>
        <tbody>
          {#each standings as s}
            <tr>
              <td class={rankCls(s.rank)}>{s.rank}</td>
              <td>
                <div class="team-cell">{s.full_name}</div>
                {#if s.level}<div class="team-sub">{s.level}</div>{/if}
              </td>
              <td class="r wl">{wl(s.wins, s.losses)}</td>
              <td class="r num">{(s.win_pct * 100).toFixed(1)}%</td>
              <td class="r num">{(s.point_pct * 100).toFixed(1)}%</td>
              <td class="r" style="color: var(--orange); font-weight: 800;">{s.score.toFixed(1)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
