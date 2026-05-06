<script>
  import { getContext } from 'svelte';
  import { api } from '$lib/api.js';
  import { shortDate } from '$lib/format.js';

  const leagueStore = getContext('leagueStore');

  let results = [];
  let loading = true;
  let error = '';
  let lastLid = null;

  async function load(lid) {
    if (!lid || lid === lastLid) return;
    lastLid = lid;
    loading = true;
    error = '';
    try {
      const data = await api.results(lid);
      results = data.results || [];
    } catch (e) {
      error = e.message || String(e);
    } finally {
      loading = false;
    }
  }

  $: if ($leagueStore.league) load($leagueStore.league.league_id);
  $: format = $leagueStore.league?.format_type;
  $: leagueSlug = $leagueStore.league?.slug;
  $: byWeek = groupBy(results, r => r.week);

  function groupBy(arr, keyFn) {
    const out = new Map();
    for (const x of arr) {
      const k = keyFn(x);
      if (!out.has(k)) out.set(k, []);
      out.get(k).push(x);
    }
    return out;
  }
</script>

<svelte:head>
  <title>{$leagueStore.league?.name ?? 'League'} — Match Results</title>
</svelte:head>

<div class="section">
  {#if loading}
    <div class="loading">Loading results…</div>
  {:else if error}
    <div class="err">{error}</div>
  {:else if !results.length}
    <div class="empty">No completed games yet.</div>
  {:else}
    {#each [...byWeek.entries()] as [week, games]}
      <div class="panel section-card">
        <div class="panel-h">
          <h3>Week {week}{games[0]?.play_date ? ' · ' + shortDate(games[0].play_date) : ''}</h3>
          <span class="pill">{games.length} game{games.length === 1 ? '' : 's'}</span>
        </div>
        <table>
          <thead>
            <tr>
              {#if format === 'partner'}
                <th class="c">R</th>
                <th>Team 1</th>
                <th class="c">Score</th>
                <th>Team 2</th>
              {:else}
                <th class="c">R</th>
                <th class="c">Group</th>
                <th>Team 1</th>
                <th class="c">Score</th>
                <th>Team 2</th>
              {/if}
            </tr>
          </thead>
          <tbody>
            {#each games as g}
              <tr>
                <td class="c muted">{g.round || '—'}</td>
                {#if format !== 'partner'}<td class="c muted">{g.group ?? '—'}</td>{/if}
                <td>
                  {#if g.t1_team_id}
                    <div class="team-cell"><a href="/{leagueSlug}/teams/{g.t1_team_id}">{g.t1_name}</a></div>
                  {/if}
                  {#if g.t1_players?.length}
                    <div class="team-sub">{g.t1_players.join(' · ')}</div>
                  {/if}
                </td>
                <td class="c">
                  <span class="score" class:score-win={g.winner === 1} class:score-loss={g.winner === 2}>{g.t1_score}</span>
                  <span class="muted"> – </span>
                  <span class="score" class:score-win={g.winner === 2} class:score-loss={g.winner === 1}>{g.t2_score}</span>
                </td>
                <td>
                  {#if g.t2_team_id}
                    <div class="team-cell"><a href="/{leagueSlug}/teams/{g.t2_team_id}">{g.t2_name}</a></div>
                  {/if}
                  {#if g.t2_players?.length}
                    <div class="team-sub">{g.t2_players.join(' · ')}</div>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/each}
  {/if}
</div>
