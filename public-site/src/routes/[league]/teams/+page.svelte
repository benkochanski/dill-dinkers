<script>
  import { getContext } from 'svelte';
  import { api } from '$lib/api.js';
  import { wl, plusMinus } from '$lib/format.js';

  const leagueStore = getContext('leagueStore');

  let teams = [];
  let loading = true;
  let error = '';
  let lastLid = null;

  async function load(lid) {
    if (!lid || lid === lastLid) return;
    lastLid = lid;
    loading = true;
    error = '';
    try {
      const data = await api.teams(lid);
      teams = data.teams || [];
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
  <title>{$leagueStore.league?.name ?? 'League'} — Teams</title>
</svelte:head>

<div class="section">
  {#if loading}
    <div class="loading">Loading teams…</div>
  {:else if error}
    <div class="err">{error}</div>
  {:else if !teams.length}
    <div class="empty">No teams yet.</div>
  {:else}
    <div class="league-grid">
      {#each teams as t}
        <a class="league-card" href="/{leagueSlug}/teams/{t.team_id}">
          <div class="day">{t.rank ? '#' + t.rank : 'Unranked'}</div>
          <h3>{t.team_name}</h3>
          <div class="meta">
            <span class="wl">{wl(t.wins, t.losses)}</span>
            {#if t.games_back > 0}<span class="dot">·</span><span>{t.games_back.toFixed(1)} GB</span>{/if}
            <span class="dot">·</span>
            <span class={t.point_diff > 0 ? 'pos' : t.point_diff < 0 ? 'neg' : ''}>{plusMinus(t.point_diff)}</span>
          </div>
          <div class="meta" style="margin-top:6px">
            {[t.player_1_name, t.player_2_name].filter(Boolean).join(' · ') || '—'}
          </div>
        </a>
      {/each}
    </div>
  {/if}
</div>
