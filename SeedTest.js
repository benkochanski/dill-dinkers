/**
 * Seeds a tiny test ladder league + a few games so we can sanity-check
 * the operator UI end-to-end.
 *
 * Run `seedTestLadder()` from the editor. Idempotent-ish: if a league
 * named "TEST Ladder" already exists, it's reused.
 */
function seedTestLadder() {
  const TEST_NAME = 'TEST Ladder';
  let league = listLeagues_().find(l => l.name === TEST_NAME);

  if (!league) {
    league = createLeague_({
      name: TEST_NAME,
      full_name: 'TEST Ladder League',
      format_type: 'ladder',
      day_of_week: 'Thursday',
      start_time: '10:30a - 12:15p',
      level: 'Levels 2-4',
      season_label: 'Mar/Apr 2026',
      status: 'active',
      num_groups: 6,
      bonus_starts_week: 3,
      weeks: [
        { week_starts: 'Mar 02', week_ends: 'Mar 08', play_date: 'Mar 05' },
        { week_starts: 'Mar 09', week_ends: 'Mar 15', play_date: 'Mar 12' },
        { week_starts: 'Mar 16', week_ends: 'Mar 22', play_date: 'Mar 19' },
      ],
    });
  }

  const seedPlayers = [
    { full_name: 'Ana Dobrita',       email: 'ana.test@example.com',     level: 'Level 3' },
    { full_name: 'Joan Mack',         email: 'joan.test@example.com',    level: 'Level 4' },
    { full_name: 'Catherine Cormier', email: 'cathy.test@example.com',   level: 'Level 3' },
    { full_name: 'Debbie Feldman',    email: 'debbie.test@example.com',  level: 'Level 3' },
    { full_name: 'Karen Bordonaro',   email: 'karen.test@example.com',   level: 'Level 3' },
    { full_name: 'Janet Downey',      email: 'janet.test@example.com',   level: 'Level 3' },
    { full_name: 'Samantha McCord',   email: 'sam.test@example.com',     level: 'Level 3' },
    { full_name: 'Jennifer Steinberg',email: 'jenny.test@example.com',   level: 'Level 3' },
  ];

  const playerIds = seedPlayers.map(p => {
    const player = upsertPlayer_(p);
    addToRoster_(league.league_id, player.player_id);
    return player.player_id;
  });

  // Skip seeding games if any already exist for this league.
  const existing = listGames_({ league_id: league.league_id });
  if (existing.length) {
    Logger.log('Test data: league %s exists with %s games — skipping game seed.',
               league.league_id, existing.length);
    return { league_id: league.league_id, players: playerIds.length, games: existing.length };
  }

  // Three games so the standings have data to chew on. Mirrors the shape
  // of the reference Ladies Social Week 1 entries.
  const G = (week, round, group, gnum, court, p1, p2, p3, p4, s1, s2) => saveGame_({
    league_id:    league.league_id,
    week_number:  week,
    round_number: round,
    group_number: group,
    game_in_match: gnum,
    court_number: court,
    play_date:    'Mar 05',
    t1_player_1_id: playerIds[p1],
    t1_player_2_id: playerIds[p2],
    t2_player_1_id: playerIds[p3],
    t2_player_2_id: playerIds[p4],
    t1_score: s1, t2_score: s2,
  });

  // Players 0–7. A few games so each appears at least once.
  G(1, 1, 1, 1, 1, 0, 3, 4, 5, 5, 8);   // Ana+Debbie 5 vs Karen+Janet 8 → K/J win
  G(1, 1, 1, 2, 2, 6, 7, 2, 1, 9, 8);   // Sam+Jenny 9 vs Cathy+Joan 8 → S/J win
  G(1, 2, 1, 1, 1, 0, 2, 3, 4, 11, 6);  // Ana+Cathy 11 vs Debbie+Karen 6 → A/C win
  G(1, 2, 1, 2, 2, 1, 5, 6, 7, 7, 11);  // Joan+Janet 7 vs Sam+Jenny 11 → S/J win
  G(1, 3, 1, 1, 1, 0, 1, 2, 3, 11, 4);  // Ana+Joan 11 vs Cathy+Debbie 4 → A/J win
  G(1, 3, 1, 2, 2, 4, 5, 6, 7, 8, 11);  // Karen+Janet 8 vs Sam+Jenny 11 → S/J win

  return {
    league_id: league.league_id,
    players: playerIds.length,
    games: listGames_({ league_id: league.league_id }).length,
  };
}

/** Quick sanity check: log standings for the test league. */
function debugStandings() {
  const league = listLeagues_().find(l => l.name === 'TEST Ladder');
  if (!league) { Logger.log('Run seedTestLadder() first.'); return; }
  const s = recomputeStandings_(league.league_id);
  s.forEach(row => Logger.log(JSON.stringify(row)));
  return s;
}
