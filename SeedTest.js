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

  // Backfill num_groups/bonus_starts_week on a previously-seeded league
  // (so older test runs pick up the new schema). Always reseed Bonus_Config.
  if (league) {
    updateWhere_('Leagues', l => l.league_id === league.league_id, l => {
      if (!l.num_groups) l.num_groups = 6;
      if (!l.bonus_starts_week) l.bonus_starts_week = 3;
    });
    seedBonusConfigStandard_(league.league_id, 6);
    league = getLeagueById_(league.league_id);
  }

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

  // Week 1 — all in group 1 (no bonus, since bonus starts week 3)
  G(1, 1, 1, 1, 1, 0, 3, 4, 5, 5, 8);   // Ana+Debbie 5 vs Karen+Janet 8 → K/J win
  G(1, 1, 1, 2, 2, 6, 7, 2, 1, 9, 8);   // Sam+Jenny 9 vs Cathy+Joan 8 → S/J win
  G(1, 2, 1, 1, 1, 0, 2, 3, 4, 11, 6);  // Ana+Cathy 11 vs Debbie+Karen 6 → A/C win
  G(1, 2, 1, 2, 2, 1, 5, 6, 7, 7, 11);  // Joan+Janet 7 vs Sam+Jenny 11 → S/J win
  G(1, 3, 1, 1, 1, 0, 1, 2, 3, 11, 4);  // Ana+Joan 11 vs Cathy+Debbie 4 → A/J win
  G(1, 3, 1, 2, 2, 4, 5, 6, 7, 8, 11);  // Karen+Janet 8 vs Sam+Jenny 11 → S/J win

  // Week 3 — varied groups so bonus formula has something to chew on.
  // Group 1 (mult 0.15), Group 3 (mult 0.09), Group 6 (mult 0.00).
  G(3, 1, 1, 1, 1, 0, 1, 2, 3, 11, 6);  // Ana+Joan in Group 1 → win, +0.15 W, +0.15 P
  G(3, 1, 3, 1, 2, 4, 5, 6, 7, 8, 11);  // Karen+Janet in Group 3 → loss; Sam+Jenny win → +0.09 W (S/J), +0.09 P (all 4)
  G(3, 1, 6, 1, 3, 2, 3, 0, 1, 11, 5);  // Cathy+Debbie in Group 6 → win, but mult 0 so no bonus
  G(3, 2, 1, 1, 1, 0, 2, 1, 3, 11, 9);  // Ana+Cathy (G1) win 11-9 → +0.15 W
  G(3, 2, 3, 1, 2, 4, 6, 5, 7, 11, 7);  // Karen+Sam (G3) win 11-7 → +0.09 W, +0.09 P all four
  G(3, 2, 6, 1, 3, 1, 7, 2, 0, 11, 4);  // Joan+Jenny (G6) — mult 0
  G(3, 3, 1, 1, 1, 5, 6, 7, 4, 11, 8);  // Janet+Sam (G1) win → +0.15 W
  G(3, 3, 3, 1, 2, 0, 3, 1, 2, 9, 11);  // Cathy+Joan (G3) win 11-9 → +0.09 W
  G(3, 3, 6, 1, 3, 4, 5, 6, 7, 8, 11);  // Sam+Jenny (G6) — mult 0

  return {
    league_id: league.league_id,
    players: playerIds.length,
    games: listGames_({ league_id: league.league_id }).length,
  };
}

/**
 * Seed a tiny partner-format test league.
 *
 * 4 teams, 1 week, each team plays the 3 other opponents → 6 games total.
 * Idempotent: skips game seed if any games already exist for the league.
 */
function seedTestPartner() {
  const TEST_NAME = 'TEST Partners';
  let league = listLeagues_().find(l => l.name === TEST_NAME);

  if (!league) {
    league = createLeague_({
      name: TEST_NAME,
      full_name: 'TEST Partners League',
      format_type: 'partner',
      day_of_week: 'Wednesday',
      start_time: '5p - 7p',
      level: 'Levels 4-6',
      season_label: 'Mar/Apr 2026',
      status: 'active',
      weeks: [
        { week_starts: 'Mar 02', week_ends: 'Mar 08', play_date: 'Mar 04' },
      ],
    });
  }

  const playerSeeds = [
    { full_name: 'Sue Daigle',         email: 'sue.test@example.com',   level: 'Level 5' },
    { full_name: 'Jennifer Murnane',   email: 'jmurnane.test@example.com', level: 'Level 5' },
    { full_name: 'Kate King',          email: 'kate.test@example.com',  level: 'Level 5' },
    { full_name: 'Alison Bush',        email: 'alison.test@example.com', level: 'Level 5' },
    { full_name: 'Paula Smyth',        email: 'paula.test@example.com', level: 'Level 5' },
    { full_name: 'Leeann Cerpovicz',   email: 'leeann.test@example.com', level: 'Level 5' },
    { full_name: 'Lindsay Yanke',      email: 'lindsay.test@example.com', level: 'Level 5' },
    { full_name: 'Jessie Kaminski',    email: 'jessie.test@example.com', level: 'Level 5' },
  ];
  const playerIds = playerSeeds.map(p => upsertPlayer_(p).player_id);

  // 4 teams of 2.
  const teamDefs = [
    { name: "Dinkin Pinktini's",  p1: 0, p2: 1 },
    { name: 'Smash Sisters',      p1: 2, p2: 3 },
    { name: 'Court Chaos',        p1: 4, p2: 5 },
    { name: 'Mama Bears',         p1: 6, p2: 7 },
  ];
  const existingTeams = listTeams_(league.league_id);
  const teamIds = teamDefs.map(td => {
    const existing = existingTeams.find(t => t.team_name === td.name);
    if (existing) return existing.team_id;
    return createTeam_(league.league_id, td.name, playerIds[td.p1], playerIds[td.p2]);
  });

  if (listGames_({ league_id: league.league_id }).length) {
    return { league_id: league.league_id, teams: teamIds.length, games: listGames_({ league_id: league.league_id }).length };
  }

  // 6 games — every team plays the 3 others (round-robin).
  // Scores chosen so Dinkin > Smash > Court > Mama in standings.
  const G = (round, court, t1, t2, s1, s2) => saveGame_({
    league_id: league.league_id,
    week_number: 1,
    round_number: round,
    match_number: round,
    game_in_match: 1,
    court_number: court,
    play_date: 'Mar 04',
    t1_team_id: teamIds[t1],
    t2_team_id: teamIds[t2],
    t1_score: s1, t2_score: s2,
  });

  G(1, 1, 0, 1, 11, 5);  // Dinkin beats Smash
  G(1, 2, 2, 3, 11, 7);  // Court beats Mama
  G(2, 1, 0, 2, 11, 8);  // Dinkin beats Court
  G(2, 2, 1, 3, 11, 6);  // Smash beats Mama
  G(3, 1, 0, 3, 11, 4);  // Dinkin beats Mama
  G(3, 2, 1, 2, 11, 9);  // Smash beats Court

  return {
    league_id: league.league_id,
    teams: teamIds.length,
    games: listGames_({ league_id: league.league_id }).length,
  };
}

/** Quick sanity check: log partner standings. */
function debugPartnerStandings() {
  const league = listLeagues_().find(l => l.name === 'TEST Partners');
  if (!league) { Logger.log('Run seedTestPartner() first.'); return; }
  const s = recomputeStandings_(league.league_id);
  s.forEach(row => Logger.log(JSON.stringify(row)));
  return s;
}

/**
 * Seed a 13-team partner-format league + run the V2 scheduler against it.
 * Idempotent — re-running reuses the existing league and teams.
 *
 * Run `seedTestPartner13()` from the Apps Script editor, then check the log
 * for the per-round bye distribution and a sample of generated matches.
 */
function seedTestPartner13() {
  const TEST_NAME = 'TEST Partners 13';
  let league = listLeagues_().find(l => l.name === TEST_NAME);
  if (!league) {
    league = createLeague_({
      name: TEST_NAME,
      full_name: 'TEST Partners — 13 teams',
      format_type: 'partner',
      day_of_week: 'Tuesday',
      start_time: '6p - 9p',
      level: 'Levels 4-6',
      season_label: 'Mar/Apr 2026',
      status: 'active',
      weeks: [
        { week_starts: 'Mar 02', week_ends: 'Mar 08', play_date: 'Mar 03' },
        { week_starts: 'Mar 09', week_ends: 'Mar 15', play_date: 'Mar 10' },
        { week_starts: 'Mar 16', week_ends: 'Mar 22', play_date: 'Mar 17' },
        { week_starts: 'Mar 23', week_ends: 'Mar 29', play_date: 'Mar 24' },
        { week_starts: 'Mar 30', week_ends: 'Apr 05', play_date: 'Mar 31' },
        { week_starts: 'Apr 06', week_ends: 'Apr 12', play_date: 'Apr 07' },
      ],
    });
  }

  // 26 players → 13 teams of 2
  const playerSeeds = [];
  for (let i = 1; i <= 26; i++) {
    playerSeeds.push({
      full_name: 'Test Player ' + i,
      email:     'tp' + i + '.test@example.com',
      level:     'Level 5',
    });
  }
  const playerIds = playerSeeds.map(p => upsertPlayer_(p).player_id);

  const existingTeams = listTeams_(league.league_id);
  for (let t = 0; t < 13; t++) {
    const teamName = 'Team ' + String.fromCharCode(65 + t);  // Team A..M
    if (!existingTeams.find(et => et.team_name === teamName)) {
      createTeam_(league.league_id, teamName, playerIds[t * 2], playerIds[t * 2 + 1]);
    }
  }

  const result = generatePartnerScheduleV2_(league.league_id, {
    rounds_per_week: 8,
    games_per_team_per_week: 6,
  });

  Logger.log('League: %s (%s)', league.name, league.league_id);
  Logger.log('Teams: %s', result.teams);
  Logger.log('Bye distribution per round: [%s] (min=%s, max=%s)',
    result.byes_per_round.join(', '), result.bye_count_min, result.bye_count_max);
  Logger.log('Total matches: %s across %s weeks', result.total_matches, result.weeks_seen);
  Logger.log('Pair balance: min=%s max=%s balanced=%s',
    result.pair_count_min, result.pair_count_max, result.balanced);
  if (result.warnings && result.warnings.length) {
    Logger.log('Warnings:');
    result.warnings.forEach(w => Logger.log('  - %s', w));
  }
  Logger.log('Sample matches:');
  result.sample.forEach(m => Logger.log('  W%s R%s C%s: %s vs %s',
    m.week_number, m.game_number, m.court_number, m.t1_team_id, m.t2_team_id));

  // Per-round play counts for week 1, sanity check.
  const weeks = getLeagueSchedule_(league.league_id);
  const w1 = weeks[0];
  const w1Matches = getObjects_('Match_Schedule')
    .filter(m => m.league_id === league.league_id && Number(m.week_number) === Number(w1.week_number));
  const perRound = {};
  w1Matches.forEach(m => {
    const r = Number(m.game_number);
    perRound[r] = (perRound[r] || 0) + 1;
  });
  Logger.log('Week 1 games per round: %s', JSON.stringify(perRound));

  return result;
}

/**
 * One-shot: rename every team in the Intermediate Mixed Partners League to a
 * randomly-shuffled pickleball-themed name. Run once from the Apps Script
 * editor — pick this function, click Run, and refresh the league admin.
 *
 * Pass a different league name as `leagueName` to use elsewhere.
 */
function renamePartnerTeamsToPickleball(leagueName) {
  leagueName = leagueName || 'Intermediate Mixed Partners League (Team Level 12 Cap)';
  const league = listLeagues_().find(l => l.name === leagueName);
  if (!league) throw new Error('League not found: ' + leagueName);
  if (league.format_type !== 'partner') throw new Error('Partner-format only.');

  const teams = listTeams_(league.league_id);
  if (!teams.length) throw new Error('No teams in league: ' + leagueName);

  const PICKLEBALL_NAMES = [
    "Dinkin' Donuts",
    "The Lob Mob",
    "Smash Brothers",
    "Volley Llamas",
    "Net Assets",
    "Spin Doctors",
    "Kitchen Bandits",
    "Court Jesters",
    "Erne Wreckers",
    "Dill With It",
    "Banger Bunch",
    "Lob City",
    "Paddle Pushers",
    "Pickle Posse",
    "Third Shot Drops",
    "Ace Holes",
    "Sour Power",
    "Soft Hands",
    "Rally Cats",
    "Brine Time",
  ];
  if (teams.length > PICKLEBALL_NAMES.length) {
    throw new Error('Need more names — have ' + PICKLEBALL_NAMES.length +
      ', league has ' + teams.length + ' teams.');
  }

  // Shuffle (Fisher-Yates).
  const pool = PICKLEBALL_NAMES.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
  }
  const picked = pool.slice(0, teams.length);

  // Map old team_name → new team_name for matching in Team_Pairings.
  const log = [];
  const renameByOld = {};
  teams.forEach((t, i) => {
    const oldName = t.team_name;
    const newName = picked[i];
    renameTeam_(t.team_id, newName);
    renameByOld[oldName] = newName;
    log.push(oldName + '  →  ' + newName);
  });
  // Also rename in Team_Pairings so the LeagueAdmin Players tab and any
  // pairing-driven flows pick up the new names. Match by team_name +
  // league_id since Team_Pairings has its own primary key.
  const pairings = getObjects_('Team_Pairings').filter(p => p.league_id === league.league_id);
  pairings.forEach(p => {
    const newName = renameByOld[p.team_name];
    if (newName && newName !== p.team_name) {
      updateWhere_('Team_Pairings',
        x => x.pairing_id === p.pairing_id,
        x => { x.team_name = newName; });
    }
  });
  cacheBust_('league:' + league.league_id + ':full');
  Logger.log('Renamed %s teams in %s:\n  %s',
    teams.length, leagueName, log.join('\n  '));
  return { league_id: league.league_id, renamed: teams.length, mapping: log };
}

/** Quick sanity check: log standings for the test league. */
function debugStandings() {
  const league = listLeagues_().find(l => l.name === 'TEST Ladder');
  if (!league) { Logger.log('Run seedTestLadder() first.'); return; }
  const s = recomputeStandings_(league.league_id);
  s.forEach(row => Logger.log(JSON.stringify(row)));
  return s;
}
