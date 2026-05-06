<script>
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { api } from '$lib/api.js';
  import { setContext } from 'svelte';
  import { writable } from 'svelte/store';

  const leagueStore = writable({ loading: true, error: '', league: null });
  setContext('leagueStore', leagueStore);

  let leagues = [];
  let resolved = null;
  let lastSlug = null;

  $: slug = $page.params.league;

  async function loadLeagues() {
    if (!leagues.length) {
      try {
        leagues = await api.leagues();
      } catch (e) {
        leagueStore.set({ loading: false, error: e.message || String(e), league: null });
        return;
      }
    }
    if (slug !== lastSlug) {
      lastSlug = slug;
      const match = leagues.find(l => l.slug === slug);
      if (!match) {
        leagueStore.set({ loading: false, error: 'League not found.', league: null });
        resolved = null;
        return;
      }
      resolved = match;
      leagueStore.set({ loading: false, error: '', league: match });
    }
  }

  onMount(loadLeagues);
  $: if (slug) loadLeagues();

  $: tabs = resolved ? [
    { name: 'Standings',     href: `/${resolved.slug}` },
    { name: 'Schedule',      href: `/${resolved.slug}/schedule` },
    { name: 'Match Results', href: `/${resolved.slug}/results` },
    ...(resolved.format_type === 'partner'
        ? [{ name: 'Teams',  href: `/${resolved.slug}/teams` }]
        : [])
  ] : [];

  $: tabActive = (href) => {
    const path = $page.url.pathname.replace(/\/$/, '');
    if (href === `/${resolved?.slug}`) {
      return path === href;
    }
    return path === href || path.startsWith(href + '/');
  };
</script>

{#if $leagueStore.loading}
  <div class="loading">Loading league…</div>
{:else if $leagueStore.error}
  <div class="section"><div class="err">{$leagueStore.error}</div></div>
{:else if resolved}
  <div class="league-header">
    <div class="league-header-inner">
      <div class="crumb"><a href="/">All Leagues</a> / {resolved.name}</div>
      <h1>{resolved.full_name || resolved.name}</h1>
      <div class="meta-row">
        <span><span class="label">Format</span> <span class="badge {resolved.format_type}">{resolved.format_type}</span></span>
        {#if resolved.level}<span><span class="label">Level</span> {resolved.level}</span>{/if}
        {#if resolved.day_of_week}<span><span class="label">Schedule</span> {resolved.day_of_week}{resolved.start_time ? ' · ' + resolved.start_time : ''}</span>{/if}
        {#if resolved.season_label}<span><span class="label">Season</span> {resolved.season_label}</span>{/if}
        {#if resolved.current_week && resolved.weeks_count}
          <span><span class="label">Week</span> {resolved.current_week} of {resolved.weeks_count}</span>
        {/if}
      </div>
      <div class="tabs">
        {#each tabs as t}
          <a class="tab" class:active={tabActive(t.href)} href={t.href}>{t.name}</a>
        {/each}
      </div>
    </div>
  </div>
  <slot />
{/if}
