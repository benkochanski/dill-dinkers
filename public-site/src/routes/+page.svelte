<script>
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';

  let leagues = [];
  let loading = true;
  let error = '';

  onMount(async () => {
    try {
      leagues = await api.leagues();
    } catch (e) {
      error = e.message || String(e);
    } finally {
      loading = false;
    }
  });

  $: activeLeagues = leagues.filter(l => l.status === 'active');
  $: otherLeagues  = leagues.filter(l => l.status !== 'active');
</script>

<svelte:head>
  <title>Dill Dinkers Leagues</title>
  <meta name="description" content="Live standings, schedules and results for Dill Dinkers pickleball leagues." />
</svelte:head>

<div class="hero">
  <div class="hero-inner">
    <div class="sub">Current Season</div>
    <h1>Active <span class="accent">Leagues</span></h1>
  </div>
</div>

<div class="section">
  {#if loading}
    <div class="loading">Loading leagues…</div>
  {:else if error}
    <div class="err">{error}</div>
  {:else if !activeLeagues.length && !otherLeagues.length}
    <div class="empty">No leagues found.</div>
  {:else}
    {#if activeLeagues.length}
      <div class="section-h"><h2>{activeLeagues.length} League{activeLeagues.length === 1 ? '' : 's'} Currently Running</h2></div>
      <div class="league-grid">
        {#each activeLeagues as l (l.league_id)}
          <a class="league-card" href="/{l.slug}">
            <div class="day">{l.day_of_week || ''}{l.start_time ? ' · ' + l.start_time : ''}</div>
            <h3>{l.name}</h3>
            <div class="meta">
              <span class="badge {l.format_type}">{l.format_type}</span>
              {#if l.level}<span>{l.level}</span>{/if}
              {#if l.current_week && l.weeks_count}
                <span class="dot">·</span>
                <span>Week {l.current_week} / {l.weeks_count}</span>
              {/if}
            </div>
          </a>
        {/each}
      </div>
    {/if}

    {#if otherLeagues.length}
      <div class="section-h" style="margin-top:32px">
        <h2>Past Seasons</h2>
      </div>
      <div class="league-grid">
        {#each otherLeagues as l (l.league_id)}
          <a class="league-card" href="/{l.slug}">
            <div class="day">{l.day_of_week || ''}{l.start_time ? ' · ' + l.start_time : ''}</div>
            <h3>{l.name}</h3>
            <div class="meta">
              <span class="badge {l.format_type}">{l.format_type}</span>
              {#if l.season_label}<span>{l.season_label}</span>{/if}
            </div>
          </a>
        {/each}
      </div>
    {/if}
  {/if}
</div>
