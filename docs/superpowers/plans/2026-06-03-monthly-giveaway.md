# Monthly Game Giveaway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an RB-members-only monthly raffle: hours played + seed-hours + community votes → weighted random draw, run from Discord.

**Architecture:** New `src/services/giveaway/` module with service + embeds + draw files, plus `src/commands/giveaway.js` (six subcommands), `src/handlers/giveawayButtons.js` (Enter + vote buttons), and three new MariaDB tables in `Royal_secretary`. Re-uses existing `playtimeService` (SquadJS pulls) and `userService` (Discord↔Steam link). All state in DB — no in-memory caches.

**Tech Stack:** Bun, discord.js v14, MariaDB (`mariadb` driver), `bun:test`, Pino. ESM only. Semicolons on, single quotes.

**Spec:** `docs/superpowers/specs/2026-06-03-monthly-giveaway-design.md`

---

## Task 1: Feature branch

**Files:**
- No files modified — branch operation only

- [ ] **Step 1: Create feature branch off current branch**

Current branch is `production`; the spec commit (`19b7c7d`) is already there. Move it onto a feature branch so we don't push code straight to production.

Run:
```bash
cd C:/Users/OleEd/Azure/RoyalSecretaryDiscordBot
git checkout -b feat/giveaway-system
```

Expected: `Switched to a new branch 'feat/giveaway-system'`

The spec commit travels with the new branch. Production branch still has it too (decide later whether to keep it there or rebase it out).

- [ ] **Step 2: Verify clean working state**

Run: `git status`

Expected: `On branch feat/giveaway-system / nothing to commit, working tree clean` (the two pre-existing prospect-transcript untracked files may still be listed — leave them alone).

---

## Task 2: Database schema

**Files:**
- Modify: `src/database/schema.js` (append three new CREATE TABLE blocks before the final `log.info` line, around line 510)

- [ ] **Step 1: Add the three tables**

Open `src/database/schema.js`. Find the closing block:

```js
  await query(`
    CREATE TABLE IF NOT EXISTS layer_rotation_current (
      ...
    )
  `);

  log.info('Database schema initialized');
}
```

Insert before the `log.info` line:

```js
  // ── Giveaway tables ──

  await query(`
    CREATE TABLE IF NOT EXISTS giveaways (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      prize           VARCHAR(255) NOT NULL,
      month_label     VARCHAR(20) NOT NULL,
      scope           ENUM('rb_only','community') DEFAULT 'rb_only',
      status          ENUM('open','voting','drawn','cancelled') DEFAULT 'open',
      draw_at         TIMESTAMP NOT NULL,
      window_days     INT DEFAULT 30,
      min_hours       DECIMAL(5,2) DEFAULT 5.00,
      hours_weight    DECIMAL(4,2) DEFAULT 1.00,
      seed_weight     DECIMAL(4,2) DEFAULT 2.00,
      vote_weight     INT DEFAULT 1,
      votes_per_voter INT DEFAULT 2,
      entry_channel_id  VARCHAR(20),
      entry_message_id  VARCHAR(20),
      vote_channel_id   VARCHAR(20),
      vote_message_id   VARCHAR(20),
      winner_user_id  VARCHAR(20) NULL,
      created_by      VARCHAR(20) NOT NULL,
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      drawn_at        TIMESTAMP NULL,
      INDEX idx_giveaways_status (status)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS giveaway_entries (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      giveaway_id    INT NOT NULL,
      user_id        VARCHAR(20) NOT NULL,
      steam_id       VARCHAR(20) NULL,
      manual_hours   DECIMAL(6,2) NULL,
      manual_seed    DECIMAL(6,2) NULL,
      added_by       VARCHAR(20) NULL,
      entered_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_entry (giveaway_id, user_id),
      FOREIGN KEY (giveaway_id) REFERENCES giveaways(id) ON DELETE CASCADE
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS giveaway_votes (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      giveaway_id  INT NOT NULL,
      voter_id     VARCHAR(20) NOT NULL,
      target_id    VARCHAR(20) NOT NULL,
      created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_vote (giveaway_id, voter_id, target_id),
      INDEX idx_voter (giveaway_id, voter_id),
      FOREIGN KEY (giveaway_id) REFERENCES giveaways(id) ON DELETE CASCADE
    )
  `);
```

- [ ] **Step 2: Boot bot against dev DB to apply schema**

Run: `bun run start` (Ctrl+C after seeing `Database schema initialized` in the logs).

Expected: bot logs `Database schema initialized` with no errors. Schema is idempotent (`CREATE TABLE IF NOT EXISTS`) — safe to re-run.

- [ ] **Step 3: Manually verify tables exist**

Run (PowerShell, connects to dev DB — use credentials from `.env`):
```powershell
mariadb -h $env:DB_HOST -u $env:DB_USER -p"$env:DB_PASSWORD" Royal_secretary -e "SHOW TABLES LIKE 'giveaway%'"
```

Expected output: `giveaways`, `giveaway_entries`, `giveaway_votes` listed.

- [ ] **Step 4: Commit**

```bash
git add src/database/schema.js
git commit -m "feat(giveaway): add giveaways, entries, votes tables"
```

---

## Task 3: Pure function — ticket computation

**Files:**
- Create: `src/services/giveaway/giveawayMath.js`
- Create: `tests/unit/giveaway/giveawayMath.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/giveaway/giveawayMath.test.js`:

```js
import { describe, it, expect } from 'bun:test';
import { computeTickets } from '../../../src/services/giveaway/giveawayMath.js';

describe('computeTickets', () => {
  it('uses manual hours when entry is a manual entry', () => {
    const entry = { manualHours: 50, manualSeed: 10, steamId: null };
    const live = null;
    const votes = 0;
    const weights = { hours: 1, seed: 2, vote: 1 };
    expect(computeTickets(entry, live, votes, weights)).toBe(70); // 50 + 2*10
  });

  it('uses live SquadJS hours when entry is a linked entry', () => {
    const entry = { manualHours: null, manualSeed: null, steamId: '7656' };
    const live = { playtimeHours: 200, seedHours: 15 };
    const votes = 3;
    const weights = { hours: 1, seed: 2, vote: 1 };
    expect(computeTickets(entry, live, votes, weights)).toBe(233); // 200 + 30 + 3
  });

  it('floors fractional totals', () => {
    const entry = { manualHours: null, manualSeed: null, steamId: '7656' };
    const live = { playtimeHours: 5.7, seedHours: 1.4 };
    const weights = { hours: 1, seed: 2, vote: 1 };
    expect(computeTickets(entry, live, 0, weights)).toBe(8); // floor(5.7 + 2.8) = 8
  });

  it('returns 0 when entry has no hours and no votes', () => {
    const entry = { manualHours: null, manualSeed: null, steamId: '7656' };
    const live = { playtimeHours: 0, seedHours: 0 };
    const weights = { hours: 1, seed: 2, vote: 1 };
    expect(computeTickets(entry, live, 0, weights)).toBe(0);
  });

  it('respects custom weights', () => {
    const entry = { manualHours: 10, manualSeed: 5, steamId: null };
    const weights = { hours: 2, seed: 3, vote: 5 };
    expect(computeTickets(entry, null, 1, weights)).toBe(40); // 20 + 15 + 5
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/giveaway/giveawayMath.test.js`

Expected: FAIL — `Cannot find module '../../../src/services/giveaway/giveawayMath.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/services/giveaway/giveawayMath.js`:

```js
export function computeTickets(entry, live, votes, weights) {
  const hours = entry.manualHours != null ? Number(entry.manualHours) : Number(live?.playtimeHours ?? 0);
  const seed  = entry.manualSeed  != null ? Number(entry.manualSeed)  : Number(live?.seedHours ?? 0);
  const raw = hours * weights.hours + seed * weights.seed + votes * weights.vote;
  return Math.floor(raw);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/giveaway/giveawayMath.test.js`

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/giveaway/giveawayMath.js tests/unit/giveaway/giveawayMath.test.js
git commit -m "feat(giveaway): add ticket computation"
```

---

## Task 4: Pure function — weighted random draw

**Files:**
- Create: `src/services/giveaway/giveawayDraw.js`
- Create: `tests/unit/giveaway/giveawayDraw.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/giveaway/giveawayDraw.test.js`:

```js
import { describe, it, expect } from 'bun:test';
import { pickWinner } from '../../../src/services/giveaway/giveawayDraw.js';

describe('pickWinner', () => {
  it('returns the only entry when there is one with tickets', () => {
    const entries = [{ userId: '1', tickets: 5 }];
    expect(pickWinner(entries, () => 0.99).userId).toBe('1');
  });

  it('picks first entry when rng rolls 0', () => {
    const entries = [
      { userId: 'a', tickets: 10 },
      { userId: 'b', tickets: 20 },
      { userId: 'c', tickets: 30 },
    ];
    expect(pickWinner(entries, () => 0).userId).toBe('a');
  });

  it('picks last entry when rng rolls near 1', () => {
    const entries = [
      { userId: 'a', tickets: 10 },
      { userId: 'b', tickets: 20 },
      { userId: 'c', tickets: 30 },
    ];
    expect(pickWinner(entries, () => 0.9999).userId).toBe('c');
  });

  it('skips zero-ticket entries', () => {
    const entries = [
      { userId: 'a', tickets: 0 },
      { userId: 'b', tickets: 10 },
    ];
    expect(pickWinner(entries, () => 0).userId).toBe('b');
  });

  it('returns null when total tickets is 0', () => {
    const entries = [
      { userId: 'a', tickets: 0 },
      { userId: 'b', tickets: 0 },
    ];
    expect(pickWinner(entries, () => 0.5)).toBe(null);
  });

  it('returns null when entries is empty', () => {
    expect(pickWinner([], () => 0.5)).toBe(null);
  });

  it('respects ticket weighting across many runs', () => {
    // 'a' has 9x more tickets than 'b' — should win ~90% of the time.
    const entries = [
      { userId: 'a', tickets: 90 },
      { userId: 'b', tickets: 10 },
    ];
    let aWins = 0;
    for (let i = 0; i < 10000; i++) {
      if (pickWinner(entries, Math.random).userId === 'a') aWins++;
    }
    // Allow ±2% slop. 88%-92% expected.
    expect(aWins).toBeGreaterThan(8800);
    expect(aWins).toBeLessThan(9200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/giveaway/giveawayDraw.test.js`

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/services/giveaway/giveawayDraw.js`:

```js
export function pickWinner(entries, rng = Math.random) {
  const eligible = entries.filter((e) => e.tickets > 0);
  if (eligible.length === 0) return null;

  const total = eligible.reduce((sum, e) => sum + e.tickets, 0);
  const roll = rng() * total;

  let cum = 0;
  for (const entry of eligible) {
    cum += entry.tickets;
    if (cum >= roll) return entry;
  }
  // Fallback for floating-point edge (roll === total).
  return eligible[eligible.length - 1];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/giveaway/giveawayDraw.test.js`

Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/giveaway/giveawayDraw.js tests/unit/giveaway/giveawayDraw.test.js
git commit -m "feat(giveaway): add weighted random winner selection"
```

---

## Task 5: Service — giveaway CRUD

**Files:**
- Create: `src/services/giveaway/giveawayService.js`

Service-layer DB calls. Tests deferred to manual integration in Task 21 because mocking the dual-pool `query()` adapter cleanly is fiddly and the surface here is thin CRUD.

- [ ] **Step 1: Implement create + lookup helpers**

Create `src/services/giveaway/giveawayService.js`:

```js
import { query } from '../../database/connection.js';
import logger from '../../logger.js';

const log = logger.child({ module: 'giveawayService' });

export async function createGiveaway({
  prize,
  monthLabel,
  drawAt,
  entryChannelId,
  createdBy,
  windowDays = 30,
  minHours = 5.0,
  hoursWeight = 1.0,
  seedWeight = 2.0,
  voteWeight = 1,
  votesPerVoter = 2,
}) {
  const result = await query(
    `INSERT INTO giveaways (
       prize, month_label, draw_at, entry_channel_id, created_by,
       window_days, min_hours, hours_weight, seed_weight, vote_weight, votes_per_voter
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [prize, monthLabel, drawAt, entryChannelId, createdBy,
     windowDays, minHours, hoursWeight, seedWeight, voteWeight, votesPerVoter]
  );
  return getGiveawayById(result.insertId);
}

export async function getGiveawayById(id) {
  const rows = await query('SELECT * FROM giveaways WHERE id = ?', [id]);
  return rows[0] || null;
}

export async function getActiveGiveaway() {
  const rows = await query(
    `SELECT * FROM giveaways WHERE status IN ('open','voting') ORDER BY id DESC LIMIT 1`
  );
  return rows[0] || null;
}

export async function setEntryMessage(giveawayId, channelId, messageId) {
  await query(
    `UPDATE giveaways SET entry_channel_id = ?, entry_message_id = ? WHERE id = ?`,
    [channelId, messageId, giveawayId]
  );
}

export async function setVoteMessage(giveawayId, channelId, messageId) {
  await query(
    `UPDATE giveaways SET vote_channel_id = ?, vote_message_id = ?, status = 'voting' WHERE id = ?`,
    [channelId, messageId, giveawayId]
  );
}

export async function markDrawn(giveawayId, winnerUserId) {
  await query(
    `UPDATE giveaways SET status = 'drawn', winner_user_id = ?, drawn_at = NOW() WHERE id = ?`,
    [winnerUserId, giveawayId]
  );
}

export async function cancelGiveaway(giveawayId) {
  await query(`UPDATE giveaways SET status = 'cancelled' WHERE id = ?`, [giveawayId]);
}

export { log };
```

- [ ] **Step 2: Smoke import**

Run: `bun -e "import('./src/services/giveaway/giveawayService.js').then(m => console.log(Object.keys(m)))"`

Expected: array containing `createGiveaway, getGiveawayById, getActiveGiveaway, setEntryMessage, setVoteMessage, markDrawn, cancelGiveaway, log`.

- [ ] **Step 3: Commit**

```bash
git add src/services/giveaway/giveawayService.js
git commit -m "feat(giveaway): add giveaway service CRUD"
```

---

## Task 6: Service — entry upsert (linked + manual)

**Files:**
- Modify: `src/services/giveaway/giveawayService.js` (append new functions)

- [ ] **Step 1: Append entry functions**

Append to `src/services/giveaway/giveawayService.js`:

```js
export async function addLinkedEntry(giveawayId, userId, steamId) {
  await query(
    `INSERT INTO giveaway_entries (giveaway_id, user_id, steam_id)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE steam_id = VALUES(steam_id)`,
    [giveawayId, userId, steamId]
  );
}

export async function upsertManualEntry(giveawayId, userId, hours, seed, addedBy) {
  await query(
    `INSERT INTO giveaway_entries (giveaway_id, user_id, manual_hours, manual_seed, added_by)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       manual_hours = VALUES(manual_hours),
       manual_seed = VALUES(manual_seed),
       added_by = VALUES(added_by)`,
    [giveawayId, userId, hours, seed, addedBy]
  );
}

export async function getEntry(giveawayId, userId) {
  const rows = await query(
    `SELECT * FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?`,
    [giveawayId, userId]
  );
  return rows[0] || null;
}

export async function listEntries(giveawayId) {
  return await query(
    `SELECT * FROM giveaway_entries WHERE giveaway_id = ? ORDER BY entered_at ASC`,
    [giveawayId]
  );
}
```

- [ ] **Step 2: Smoke import**

Run: `bun -e "import('./src/services/giveaway/giveawayService.js').then(m => console.log(m.addLinkedEntry?.name, m.upsertManualEntry?.name, m.listEntries?.name))"`

Expected: `addLinkedEntry upsertManualEntry listEntries`.

- [ ] **Step 3: Commit**

```bash
git add src/services/giveaway/giveawayService.js
git commit -m "feat(giveaway): add entry upsert (linked + manual)"
```

---

## Task 7: Service — vote insert with cap

**Files:**
- Modify: `src/services/giveaway/giveawayService.js` (append)

- [ ] **Step 1: Append vote functions**

Append to `src/services/giveaway/giveawayService.js`:

```js
export async function countVotesByVoter(giveawayId, voterId) {
  const rows = await query(
    `SELECT COUNT(*) AS n FROM giveaway_votes WHERE giveaway_id = ? AND voter_id = ?`,
    [giveawayId, voterId]
  );
  return Number(rows[0]?.n) || 0;
}

export async function countVotesForTarget(giveawayId, targetId) {
  const rows = await query(
    `SELECT COUNT(*) AS n FROM giveaway_votes WHERE giveaway_id = ? AND target_id = ?`,
    [giveawayId, targetId]
  );
  return Number(rows[0]?.n) || 0;
}

export async function getVoteCountsByTarget(giveawayId) {
  const rows = await query(
    `SELECT target_id AS targetId, COUNT(*) AS n
       FROM giveaway_votes
      WHERE giveaway_id = ?
      GROUP BY target_id`,
    [giveawayId]
  );
  const map = new Map();
  for (const row of rows) map.set(row.targetId, Number(row.n));
  return map;
}

/**
 * Attempts to insert a vote. Returns:
 *   { ok: true } on success
 *   { ok: false, reason: 'cap' } if voter has hit votes_per_voter
 *   { ok: false, reason: 'duplicate' } if voter already voted for this target
 *   { ok: false, reason: 'self' } if voter tried to vote for themselves
 */
export async function castVote(giveaway, voterId, targetId) {
  if (voterId === targetId) return { ok: false, reason: 'self' };

  const used = await countVotesByVoter(giveaway.id, voterId);
  if (used >= giveaway.votes_per_voter) return { ok: false, reason: 'cap' };

  try {
    await query(
      `INSERT INTO giveaway_votes (giveaway_id, voter_id, target_id) VALUES (?, ?, ?)`,
      [giveaway.id, voterId, targetId]
    );
    return { ok: true };
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY' || err.errno === 1062) {
      return { ok: false, reason: 'duplicate' };
    }
    log.error({ err, giveawayId: giveaway.id, voterId, targetId }, 'castVote failed');
    throw err;
  }
}
```

- [ ] **Step 2: Smoke import**

Run: `bun -e "import('./src/services/giveaway/giveawayService.js').then(m => console.log(m.castVote?.name, m.countVotesByVoter?.name, m.getVoteCountsByTarget?.name))"`

Expected: `castVote countVotesByVoter getVoteCountsByTarget`.

- [ ] **Step 3: Commit**

```bash
git add src/services/giveaway/giveawayService.js
git commit -m "feat(giveaway): add vote casting with cap and dedupe"
```

---

## Task 8: Service — leaderboard computation

**Files:**
- Modify: `src/services/giveaway/giveawayService.js` (append)

Joins entries with live SquadJS hours, computes tickets, returns sorted leaderboard.

- [ ] **Step 1: Append leaderboard function**

Append to `src/services/giveaway/giveawayService.js`:

```js
import { getPlaytime } from '../playtimeService.js';
import { computeTickets } from './giveawayMath.js';

/**
 * Returns entries with computed ticket counts, sorted desc.
 * windowStartIso is the start date for the SquadJS lookup window (YYYY-MM-DD).
 */
export async function computeLeaderboard(giveaway, windowStartIso) {
  const entries = await listEntries(giveaway.id);
  const voteCounts = await getVoteCountsByTarget(giveaway.id);

  const weights = {
    hours: Number(giveaway.hours_weight),
    seed: Number(giveaway.seed_weight),
    vote: Number(giveaway.vote_weight),
  };

  const results = await Promise.all(entries.map(async (e) => {
    const live = e.steam_id
      ? await getPlaytime(e.steam_id, windowStartIso).catch(() => null)
      : null;
    const votes = voteCounts.get(e.user_id) || 0;
    const tickets = computeTickets(
      { manualHours: e.manual_hours, manualSeed: e.manual_seed, steamId: e.steam_id },
      live,
      votes,
      weights
    );
    return {
      userId: e.user_id,
      steamId: e.steam_id,
      manual: e.manual_hours != null,
      hours: e.manual_hours != null ? Number(e.manual_hours) : Number(live?.playtimeHours ?? 0),
      seed:  e.manual_seed  != null ? Number(e.manual_seed)  : Number(live?.seedHours ?? 0),
      votes,
      tickets,
    };
  }));

  results.sort((a, b) => b.tickets - a.tickets);
  return results;
}

export function windowStartIso(windowDays) {
  const d = new Date(Date.now() - windowDays * 86400000);
  return d.toISOString().slice(0, 10);
}
```

Note: this adds two new imports at the top of the file. Move the `import` lines from this snippet to the top of the file with the existing imports.

- [ ] **Step 2: Smoke import**

Run: `bun -e "import('./src/services/giveaway/giveawayService.js').then(m => console.log(typeof m.computeLeaderboard, typeof m.windowStartIso))"`

Expected: `function function`.

- [ ] **Step 3: Commit**

```bash
git add src/services/giveaway/giveawayService.js
git commit -m "feat(giveaway): add leaderboard computation"
```

---

## Task 9: Embeds — entry post + Enter button

**Files:**
- Create: `src/services/giveaway/giveawayEmbeds.js`

- [ ] **Step 1: Create embed builders**

Create `src/services/giveaway/giveawayEmbeds.js`:

```js
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

const COLOR_GIVEAWAY = 0xFFD700;
const COLOR_WINNER = 0x57F287;
const COLOR_INFO = 0x5865F2;

export function buildEntryEmbed(giveaway, entryCount, topPlayed = [], topSeed = []) {
  const lines = [
    `**Prize:** ${giveaway.prize}`,
    '',
    'Earn raffle tickets by playing on RB:',
    `- **${Number(giveaway.hours_weight)}** ticket per hour played`,
    `- **+${Number(giveaway.seed_weight)}** tickets per hour seeding`,
    `- **+${Number(giveaway.vote_weight)}** ticket per community vote (RB only)`,
    '',
    `Minimum to enter: **${Number(giveaway.min_hours)}h** played in the last ${giveaway.window_days} days.`,
    `Draw: <t:${Math.floor(new Date(giveaway.draw_at).getTime() / 1000)}:F>`,
    '',
    `Entries so far: **${entryCount}**`,
  ];

  const embed = new EmbedBuilder()
    .setTitle(`RB Member Game Giveaway — ${giveaway.month_label}`)
    .setDescription(lines.join('\n'))
    .setColor(COLOR_GIVEAWAY);

  if (topPlayed.length) {
    embed.addFields({
      name: 'Top Played',
      value: topPlayed.map((r, i) => `${i + 1}. <@${r.userId}> — ${r.hours}h`).join('\n') || '*(none yet)*',
      inline: true,
    });
  }
  if (topSeed.length) {
    embed.addFields({
      name: 'Top Seeding',
      value: topSeed.map((r, i) => `${i + 1}. <@${r.userId}> — ${r.seed}h`).join('\n') || '*(none yet)*',
      inline: true,
    });
  }

  return embed;
}

export function buildEntryRow(giveawayId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`giveaway_enter:${giveawayId}`)
      .setLabel('Enter Giveaway')
      .setStyle(ButtonStyle.Primary)
      .setEmoji({ name: '🎟' })  // single emoji char, not user-facing copy
  );
}
```

- [ ] **Step 2: Smoke build**

Run:
```bash
bun -e "import('./src/services/giveaway/giveawayEmbeds.js').then(m => { const e = m.buildEntryEmbed({prize:'Test',month_label:'May 2026',hours_weight:1,seed_weight:2,vote_weight:1,min_hours:5,window_days:30,draw_at:new Date().toISOString()}, 0); console.log(e.data.title); })"
```

Expected: `RB Member Game Giveaway — May 2026`.

- [ ] **Step 3: Commit**

```bash
git add src/services/giveaway/giveawayEmbeds.js
git commit -m "feat(giveaway): add entry embed and Enter button"
```

---

## Task 10: Embeds — vote post + paginated buttons

**Files:**
- Modify: `src/services/giveaway/giveawayEmbeds.js` (append)

Vote message: 1 embed listing entrants, ≤25 buttons (5 rows × 5) per message. >25 entrants → multiple messages (each their own page).

- [ ] **Step 1: Append vote embed builder**

Append to `src/services/giveaway/giveawayEmbeds.js`:

```js
export const VOTE_BUTTONS_PER_MESSAGE = 25;
const BUTTONS_PER_ROW = 5;

export function buildVoteEmbed(giveaway, page, totalPages) {
  const pageSuffix = totalPages > 1 ? ` — page ${page + 1}/${totalPages}` : '';
  return new EmbedBuilder()
    .setTitle(`Community Vote — ${giveaway.month_label}${pageSuffix}`)
    .setDescription([
      `**Who has gone above and beyond for the community this month?**`,
      '',
      `You can vote for up to **${giveaway.votes_per_voter}** different entrants.`,
      `Each vote adds **+${Number(giveaway.vote_weight)}** raffle ticket for that person.`,
      'You cannot vote for the same person twice.',
    ].join('\n'))
    .setColor(COLOR_INFO);
}

/**
 * Returns an array of message payloads (one per page) for the vote post.
 * entries: [{ userId, displayName }]
 */
export function buildVoteMessages(giveaway, entries) {
  const pages = [];
  for (let i = 0; i < entries.length; i += VOTE_BUTTONS_PER_MESSAGE) {
    pages.push(entries.slice(i, i + VOTE_BUTTONS_PER_MESSAGE));
  }
  if (pages.length === 0) pages.push([]);

  return pages.map((pageEntries, pageIdx) => {
    const rows = [];
    for (let i = 0; i < pageEntries.length; i += BUTTONS_PER_ROW) {
      const row = new ActionRowBuilder();
      for (const entry of pageEntries.slice(i, i + BUTTONS_PER_ROW)) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`giveaway_vote:${giveaway.id}:${entry.userId}`)
            .setLabel(truncate(entry.displayName, 80))
            .setStyle(ButtonStyle.Secondary)
        );
      }
      rows.push(row);
    }
    return {
      embeds: [buildVoteEmbed(giveaway, pageIdx, pages.length)],
      components: rows,
    };
  });
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
```

- [ ] **Step 2: Smoke build**

Run:
```bash
bun -e "import('./src/services/giveaway/giveawayEmbeds.js').then(m => { const pages = m.buildVoteMessages({id:1,month_label:'May',votes_per_voter:2,vote_weight:1}, Array.from({length:30},(_,i)=>({userId:String(i),displayName:'User'+i}))); console.log('pages:', pages.length, 'rows page0:', pages[0].components.length); })"
```

Expected: `pages: 2 rows page0: 5` (25 entrants on page 0 → 5 rows × 5 buttons; 5 entrants on page 1 → 1 row).

- [ ] **Step 3: Commit**

```bash
git add src/services/giveaway/giveawayEmbeds.js
git commit -m "feat(giveaway): add vote embed and paginated buttons"
```

---

## Task 11: Embeds — leaderboard, winner, confirmation

**Files:**
- Modify: `src/services/giveaway/giveawayEmbeds.js` (append)

- [ ] **Step 1: Append remaining embed builders**

Append to `src/services/giveaway/giveawayEmbeds.js`:

```js
export function buildLeaderboardEmbed(giveaway, leaderboard, limit = 20) {
  const top = leaderboard.slice(0, limit);
  const lines = top.map((r, i) => {
    const tag = r.manual ? ' *(manual)*' : '';
    return `\`${String(i + 1).padStart(2, ' ')}.\` <@${r.userId}> — **${r.tickets}** tickets `
      + `(${r.hours}h + 2×${r.seed}h seed + ${r.votes} votes)${tag}`;
  });
  return new EmbedBuilder()
    .setTitle(`Leaderboard — ${giveaway.month_label}`)
    .setDescription(lines.length ? lines.join('\n') : '*No entries yet.*')
    .setColor(COLOR_INFO)
    .setFooter({ text: `Total entries: ${leaderboard.length}` });
}

export function buildWinnerEmbed(giveaway, winner, leaderboard) {
  const total = leaderboard.reduce((s, e) => s + e.tickets, 0);
  const top5 = leaderboard.slice(0, 5);
  const breakdown = top5.map((r, i) =>
    `${i + 1}. <@${r.userId}> — ${r.tickets} tickets`
  ).join('\n');

  return new EmbedBuilder()
    .setTitle(`Winner — ${giveaway.month_label}`)
    .setDescription([
      `Prize: **${giveaway.prize}**`,
      '',
      `Winner: <@${winner.userId}>`,
      `Tickets: **${winner.tickets}** of ${total}`,
      `Entries: **${leaderboard.length}**`,
      '',
      '**Top 5:**',
      breakdown || '*(only one entrant)*',
    ].join('\n'))
    .setColor(COLOR_WINNER);
}

export function buildEnterConfirmEmbed(tickets, hours, seed) {
  return new EmbedBuilder()
    .setTitle('Entered!')
    .setDescription(
      `You currently have **${tickets}** tickets `
      + `(${hours}h played + 2×${seed}h seeding).\n`
      + 'Vote post opens later this month.'
    )
    .setColor(COLOR_WINNER);
}
```

- [ ] **Step 2: Smoke build**

Run:
```bash
bun -e "import('./src/services/giveaway/giveawayEmbeds.js').then(m => { const lb = [{userId:'1',hours:10,seed:5,votes:1,tickets:21,manual:false}]; console.log(m.buildLeaderboardEmbed({month_label:'May 2026'}, lb).data.title); })"
```

Expected: `Leaderboard — May 2026`.

- [ ] **Step 3: Commit**

```bash
git add src/services/giveaway/giveawayEmbeds.js
git commit -m "feat(giveaway): add leaderboard, winner, confirm embeds"
```

---

## Task 12: Handler — Enter button

**Files:**
- Create: `src/handlers/giveawayButtons.js`

- [ ] **Step 1: Implement Enter handler**

Create `src/handlers/giveawayButtons.js`:

```js
import { errorEmbed } from '../utils/embed.js';
import { getStoredSteamId } from '../services/userService.js';
import { getPlaytime } from '../services/playtimeService.js';
import {
  getGiveawayById,
  addLinkedEntry,
  countVotesForTarget,
  windowStartIso,
} from '../services/giveaway/giveawayService.js';
import { computeTickets } from '../services/giveaway/giveawayMath.js';
import { buildEnterConfirmEmbed } from '../services/giveaway/giveawayEmbeds.js';
import logger from '../logger.js';

const log = logger.child({ module: 'giveawayButtons' });

export async function handleEnter(interaction) {
  const giveawayId = Number(interaction.customId.split(':')[1]);
  await interaction.deferReply({ flags: ['Ephemeral'] });

  const giveaway = await getGiveawayById(giveawayId);
  if (!giveaway || giveaway.status === 'cancelled' || giveaway.status === 'drawn') {
    return interaction.editReply({ embeds: [errorEmbed('This giveaway is no longer accepting entries.')] });
  }

  const steamId = await getStoredSteamId(interaction.user.id);
  if (!steamId) {
    return interaction.editReply({
      embeds: [errorEmbed('You need to link your Steam account first using the verify panel.')],
    });
  }

  const live = await getPlaytime(steamId, windowStartIso(giveaway.window_days)).catch((err) => {
    log.warn({ err, userId: interaction.user.id, steamId }, 'getPlaytime failed');
    return null;
  });

  if (!live || live.playtimeHours < Number(giveaway.min_hours)) {
    return interaction.editReply({
      embeds: [errorEmbed(
        `You need at least ${Number(giveaway.min_hours)}h played on RB in the last ${giveaway.window_days} days. `
        + `You have ${live?.playtimeHours ?? 0}h.`
      )],
    });
  }

  await addLinkedEntry(giveaway.id, interaction.user.id, steamId);

  const votes = await countVotesForTarget(giveaway.id, interaction.user.id);
  const tickets = computeTickets(
    { manualHours: null, manualSeed: null, steamId },
    live,
    votes,
    { hours: Number(giveaway.hours_weight), seed: Number(giveaway.seed_weight), vote: Number(giveaway.vote_weight) }
  );

  await interaction.editReply({
    embeds: [buildEnterConfirmEmbed(tickets, live.playtimeHours, live.seedHours)],
  });
}
```

- [ ] **Step 2: Smoke import**

Run: `bun -e "import('./src/handlers/giveawayButtons.js').then(m => console.log(typeof m.handleEnter))"`

Expected: `function`.

- [ ] **Step 3: Commit**

```bash
git add src/handlers/giveawayButtons.js
git commit -m "feat(giveaway): add Enter button handler"
```

---

## Task 13: Handler — Vote button

**Files:**
- Modify: `src/handlers/giveawayButtons.js` (append)

- [ ] **Step 1: Append vote handler**

Update the existing imports at the top of `src/handlers/giveawayButtons.js`. Add `castVote` and `countVotesByVoter` to the existing giveawayService import; add `config` and `successEmbed`:

```js
import { successEmbed, errorEmbed } from '../utils/embed.js';
import { getStoredSteamId } from '../services/userService.js';
import { getPlaytime } from '../services/playtimeService.js';
import {
  getGiveawayById,
  addLinkedEntry,
  countVotesForTarget,
  windowStartIso,
  castVote,
  countVotesByVoter,
} from '../services/giveaway/giveawayService.js';
import { computeTickets } from '../services/giveaway/giveawayMath.js';
import { buildEnterConfirmEmbed } from '../services/giveaway/giveawayEmbeds.js';
import config from '../config.js';
import logger from '../logger.js';
```

Append at the bottom:

```js
export async function handleVote(interaction) {
  const [, giveawayIdStr, targetId] = interaction.customId.split(':');
  const giveawayId = Number(giveawayIdStr);
  await interaction.deferReply({ flags: ['Ephemeral'] });

  const memberRoleId = config.prospects?.memberRoleId;
  if (memberRoleId && !interaction.member?.roles?.cache?.has(memberRoleId)) {
    return interaction.editReply({ embeds: [errorEmbed('Voting is restricted to RB members.')] });
  }

  const giveaway = await getGiveawayById(giveawayId);
  if (!giveaway || giveaway.status !== 'voting') {
    return interaction.editReply({ embeds: [errorEmbed('Voting is closed.')] });
  }

  const result = await castVote(giveaway, interaction.user.id, targetId);
  if (!result.ok) {
    const msg = {
      cap: `You've used all ${giveaway.votes_per_voter} of your votes.`,
      duplicate: 'You already voted for this entrant.',
      self: 'You cannot vote for yourself.',
    }[result.reason] || 'Vote failed.';
    return interaction.editReply({ embeds: [errorEmbed(msg)] });
  }

  const usedAfter = await countVotesByVoter(giveaway.id, interaction.user.id);
  const remaining = giveaway.votes_per_voter - usedAfter;

  await interaction.editReply({
    embeds: [successEmbed(`Vote recorded for <@${targetId}>. You have ${remaining} vote(s) left.`)],
  });
}
```

- [ ] **Step 2: Smoke import**

Run: `bun -e "import('./src/handlers/giveawayButtons.js').then(m => console.log(typeof m.handleVote))"`

Expected: `function`.

- [ ] **Step 3: Commit**

```bash
git add src/handlers/giveawayButtons.js
git commit -m "feat(giveaway): add Vote button handler"
```

---

## Task 14: Command shell + `start` subcommand

**Files:**
- Create: `src/commands/giveaway.js`

- [ ] **Step 1: Implement command + start subcommand**

Create `src/commands/giveaway.js`:

```js
import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { successEmbed, errorEmbed } from '../utils/embed.js';
import {
  createGiveaway,
  getActiveGiveaway,
  setEntryMessage,
} from '../services/giveaway/giveawayService.js';
import { buildEntryEmbed, buildEntryRow } from '../services/giveaway/giveawayEmbeds.js';
import logger from '../logger.js';

const log = logger.child({ module: 'cmd:giveaway' });

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function lastDayOfThisMonthIso() {
  const now = new Date();
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59));
  return last;
}

function currentMonthLabel() {
  const now = new Date();
  return `${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
}

export default {
  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Manage the monthly RB game giveaway')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s
      .setName('start')
      .setDescription('Post a new monthly giveaway entry message')
      .addStringOption((o) => o.setName('prize').setDescription('Prize name').setRequired(true))
      .addChannelOption((o) => o.setName('channel').setDescription('Channel to post the entry message').setRequired(true))
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'start') return handleStart(interaction);
    return interaction.reply({ embeds: [errorEmbed(`Unknown subcommand: ${sub}`)], flags: ['Ephemeral'] });
  },
};

async function handleStart(interaction) {
  await interaction.deferReply({ flags: ['Ephemeral'] });

  const existing = await getActiveGiveaway();
  if (existing) {
    return interaction.editReply({
      embeds: [errorEmbed(`A giveaway is already active (id ${existing.id}, status ${existing.status}). Cancel or draw it first.`)],
    });
  }

  const prize = interaction.options.getString('prize', true);
  const channel = interaction.options.getChannel('channel', true);

  const giveaway = await createGiveaway({
    prize,
    monthLabel: currentMonthLabel(),
    drawAt: lastDayOfThisMonthIso(),
    entryChannelId: channel.id,
    createdBy: interaction.user.id,
  });

  const message = await channel.send({
    embeds: [buildEntryEmbed(giveaway, 0)],
    components: [buildEntryRow(giveaway.id)],
  });

  await setEntryMessage(giveaway.id, channel.id, message.id);

  log.info({ giveawayId: giveaway.id, prize, channelId: channel.id }, 'Giveaway started');
  await interaction.editReply({
    embeds: [successEmbed(`Giveaway #${giveaway.id} posted in ${channel}.\nPrize: **${prize}**`)],
  });
}
```

- [ ] **Step 2: Smoke import**

Run: `bun -e "import('./src/commands/giveaway.js').then(m => console.log(m.default.data.name))"`

Expected: `giveaway`.

- [ ] **Step 3: Commit**

```bash
git add src/commands/giveaway.js
git commit -m "feat(giveaway): add /giveaway command and start subcommand"
```

---

## Task 15: `add-entry` subcommand

**Files:**
- Modify: `src/commands/giveaway.js`

- [ ] **Step 1: Add subcommand to SlashCommandBuilder**

In `src/commands/giveaway.js`, add to the `data: new SlashCommandBuilder()...` chain (after the `start` subcommand):

```js
    .addSubcommand((s) => s
      .setName('add-entry')
      .setDescription('Manually add a non-linked community member to the active giveaway')
      .addUserOption((o) => o.setName('user').setDescription('Discord user').setRequired(true))
      .addNumberOption((o) => o.setName('hours').setDescription('Played hours to credit').setRequired(true).setMinValue(0))
      .addNumberOption((o) => o.setName('seed').setDescription('Seed hours to credit').setRequired(true).setMinValue(0))
    )
```

- [ ] **Step 2: Add dispatch + handler**

In the `execute` function, add before the unknown-subcommand fallback:

```js
    if (sub === 'add-entry') return handleAddEntry(interaction);
```

Add `upsertManualEntry` to the existing giveawayService import block at the top of the file. Then add at the bottom of the file:

```js
async function handleAddEntry(interaction) {
  await interaction.deferReply({ flags: ['Ephemeral'] });

  const giveaway = await getActiveGiveaway();
  if (!giveaway) {
    return interaction.editReply({ embeds: [errorEmbed('No active giveaway.')] });
  }
  if (giveaway.status === 'drawn' || giveaway.status === 'cancelled') {
    return interaction.editReply({ embeds: [errorEmbed(`Giveaway is ${giveaway.status}; cannot add entries.`)] });
  }

  const user = interaction.options.getUser('user', true);
  const hours = interaction.options.getNumber('hours', true);
  const seed = interaction.options.getNumber('seed', true);

  await upsertManualEntry(giveaway.id, user.id, hours, seed, interaction.user.id);

  log.info({ giveawayId: giveaway.id, userId: user.id, hours, seed, addedBy: interaction.user.id }, 'Manual entry added');
  await interaction.editReply({
    embeds: [successEmbed(`Added/updated manual entry for ${user}: ${hours}h played, ${seed}h seed.`)],
  });
}
```

- [ ] **Step 3: Smoke test in dev**

Run: `bun run start` and confirm the bot starts without errors. Ctrl+C to stop.

Expected: no errors related to the new file.

- [ ] **Step 4: Commit**

```bash
git add src/commands/giveaway.js
git commit -m "feat(giveaway): add /giveaway add-entry subcommand"
```

---

## Task 16: `leaderboard` subcommand

**Files:**
- Modify: `src/commands/giveaway.js`

- [ ] **Step 1: Add subcommand**

Add to the SlashCommandBuilder chain:

```js
    .addSubcommand((s) => s
      .setName('leaderboard')
      .setDescription('Show current ticket leaderboard for the active giveaway')
    )
```

- [ ] **Step 2: Add dispatch + handler**

Add to dispatcher:

```js
    if (sub === 'leaderboard') return handleLeaderboard(interaction);
```

Add to the imports block:
```js
import { computeLeaderboard, windowStartIso } from '../services/giveaway/giveawayService.js';
import { buildLeaderboardEmbed } from '../services/giveaway/giveawayEmbeds.js';
```

Add handler at the bottom of the file:

```js
async function handleLeaderboard(interaction) {
  await interaction.deferReply({ flags: ['Ephemeral'] });
  const giveaway = await getActiveGiveaway();
  if (!giveaway) {
    return interaction.editReply({ embeds: [errorEmbed('No active giveaway.')] });
  }
  const leaderboard = await computeLeaderboard(giveaway, windowStartIso(giveaway.window_days));
  await interaction.editReply({ embeds: [buildLeaderboardEmbed(giveaway, leaderboard)] });
}
```

- [ ] **Step 3: Smoke import**

Run: `bun -e "import('./src/commands/giveaway.js').then(m => console.log(m.default.data.options.map(o => o.name)))"`

Expected: `[ 'start', 'add-entry', 'leaderboard' ]`.

- [ ] **Step 4: Commit**

```bash
git add src/commands/giveaway.js
git commit -m "feat(giveaway): add /giveaway leaderboard subcommand"
```

---

## Task 17: `open-vote` subcommand

**Files:**
- Modify: `src/commands/giveaway.js`

- [ ] **Step 1: Add subcommand to builder**

```js
    .addSubcommand((s) => s
      .setName('open-vote')
      .setDescription('Post the community vote message (RB-only channel)')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel for vote post (defaults to entry channel)').setRequired(false))
    )
```

- [ ] **Step 2: Add dispatch + handler**

Dispatcher:

```js
    if (sub === 'open-vote') return handleOpenVote(interaction);
```

Imports to add:

```js
import { listEntries, setVoteMessage } from '../services/giveaway/giveawayService.js';
import { buildVoteMessages } from '../services/giveaway/giveawayEmbeds.js';
```

Handler:

```js
async function handleOpenVote(interaction) {
  await interaction.deferReply({ flags: ['Ephemeral'] });
  const giveaway = await getActiveGiveaway();
  if (!giveaway) return interaction.editReply({ embeds: [errorEmbed('No active giveaway.')] });
  if (giveaway.status !== 'open') {
    return interaction.editReply({ embeds: [errorEmbed(`Giveaway is in status '${giveaway.status}'; expected 'open'.`)] });
  }

  const entries = await listEntries(giveaway.id);
  if (entries.length === 0) {
    return interaction.editReply({ embeds: [errorEmbed('No one has entered yet.')] });
  }

  const channel = interaction.options.getChannel('channel')
    || await interaction.guild.channels.fetch(giveaway.entry_channel_id);
  if (!channel) {
    return interaction.editReply({ embeds: [errorEmbed('Could not resolve vote channel.')] });
  }

  // Resolve display names for buttons.
  const enriched = await Promise.all(entries.map(async (e) => {
    const member = await interaction.guild.members.fetch(e.user_id).catch(() => null);
    return { userId: e.user_id, displayName: member?.displayName || e.user_id };
  }));

  const pages = buildVoteMessages(giveaway, enriched);
  let firstMessage = null;
  for (const payload of pages) {
    const sent = await channel.send(payload);
    if (!firstMessage) firstMessage = sent;
  }

  await setVoteMessage(giveaway.id, channel.id, firstMessage.id);

  log.info({ giveawayId: giveaway.id, pages: pages.length, channelId: channel.id }, 'Vote post opened');
  await interaction.editReply({
    embeds: [successEmbed(`Vote post opened in ${channel} (${pages.length} message${pages.length > 1 ? 's' : ''}).`)],
  });
}
```

- [ ] **Step 3: Smoke import**

Run: `bun -e "import('./src/commands/giveaway.js').then(m => console.log(m.default.data.options.map(o => o.name)))"`

Expected: `[ 'start', 'add-entry', 'leaderboard', 'open-vote' ]`.

- [ ] **Step 4: Commit**

```bash
git add src/commands/giveaway.js
git commit -m "feat(giveaway): add /giveaway open-vote subcommand"
```

---

## Task 18: `draw` subcommand

**Files:**
- Modify: `src/commands/giveaway.js`

- [ ] **Step 1: Add subcommand**

```js
    .addSubcommand((s) => s
      .setName('draw')
      .setDescription('Run the weighted random draw and post the winner')
    )
```

- [ ] **Step 2: Add dispatch + handler**

Dispatcher:

```js
    if (sub === 'draw') return handleDraw(interaction);
```

Imports to add:

```js
import { markDrawn } from '../services/giveaway/giveawayService.js';
import { pickWinner } from '../services/giveaway/giveawayDraw.js';
import { buildWinnerEmbed } from '../services/giveaway/giveawayEmbeds.js';
```

Handler:

```js
async function handleDraw(interaction) {
  await interaction.deferReply({ flags: ['Ephemeral'] });
  const giveaway = await getActiveGiveaway();
  if (!giveaway) return interaction.editReply({ embeds: [errorEmbed('No active giveaway.')] });
  if (giveaway.status === 'drawn') {
    return interaction.editReply({ embeds: [errorEmbed(`Already drawn; winner: <@${giveaway.winner_user_id}>.`)] });
  }
  if (giveaway.status === 'cancelled') {
    return interaction.editReply({ embeds: [errorEmbed('Giveaway is cancelled.')] });
  }

  const leaderboard = await computeLeaderboard(giveaway, windowStartIso(giveaway.window_days));
  const winnerRow = pickWinner(leaderboard);
  if (!winnerRow) {
    return interaction.editReply({ embeds: [errorEmbed('No eligible entries (total tickets is 0).')] });
  }

  await markDrawn(giveaway.id, winnerRow.userId);

  const channel = await interaction.guild.channels.fetch(giveaway.entry_channel_id).catch(() => null);
  const target = channel || interaction.channel;
  await target.send({ embeds: [buildWinnerEmbed(giveaway, winnerRow, leaderboard)] });

  log.info({ giveawayId: giveaway.id, winnerId: winnerRow.userId, tickets: winnerRow.tickets }, 'Giveaway drawn');
  await interaction.editReply({
    embeds: [successEmbed(`Winner posted in ${target}: <@${winnerRow.userId}> with ${winnerRow.tickets} tickets.`)],
  });
}
```

- [ ] **Step 3: Smoke import**

Run: `bun -e "import('./src/commands/giveaway.js').then(m => console.log(m.default.data.options.map(o => o.name)))"`

Expected: `[ 'start', 'add-entry', 'leaderboard', 'open-vote', 'draw' ]`.

- [ ] **Step 4: Commit**

```bash
git add src/commands/giveaway.js
git commit -m "feat(giveaway): add /giveaway draw subcommand"
```

---

## Task 19: `cancel` subcommand

**Files:**
- Modify: `src/commands/giveaway.js`

- [ ] **Step 1: Add subcommand**

```js
    .addSubcommand((s) => s
      .setName('cancel')
      .setDescription('Cancel the active giveaway and delete its messages')
    )
```

- [ ] **Step 2: Add dispatch + handler**

Dispatcher:

```js
    if (sub === 'cancel') return handleCancel(interaction);
```

Add `cancelGiveaway` to the existing giveawayService import block.

Handler:

```js
async function handleCancel(interaction) {
  await interaction.deferReply({ flags: ['Ephemeral'] });
  const giveaway = await getActiveGiveaway();
  if (!giveaway) return interaction.editReply({ embeds: [errorEmbed('No active giveaway.')] });

  await cancelGiveaway(giveaway.id);

  for (const [chId, mId] of [
    [giveaway.entry_channel_id, giveaway.entry_message_id],
    [giveaway.vote_channel_id, giveaway.vote_message_id],
  ]) {
    if (!chId || !mId) continue;
    const ch = await interaction.guild.channels.fetch(chId).catch(() => null);
    if (!ch) continue;
    const msg = await ch.messages.fetch(mId).catch(() => null);
    if (msg) await msg.delete().catch((err) => log.warn({ err, mId }, 'Failed to delete giveaway message'));
  }

  log.info({ giveawayId: giveaway.id }, 'Giveaway cancelled');
  await interaction.editReply({ embeds: [successEmbed(`Giveaway #${giveaway.id} cancelled.`)] });
}
```

- [ ] **Step 3: Smoke import**

Run: `bun -e "import('./src/commands/giveaway.js').then(m => console.log(m.default.data.options.map(o => o.name)))"`

Expected: `[ 'start', 'add-entry', 'leaderboard', 'open-vote', 'draw', 'cancel' ]`.

- [ ] **Step 4: Commit**

```bash
git add src/commands/giveaway.js
git commit -m "feat(giveaway): add /giveaway cancel subcommand"
```

---

## Task 20: Wire button handlers into interactionCreate

**Files:**
- Modify: `src/events/interactionCreate.js`

- [ ] **Step 1: Add import**

In `src/events/interactionCreate.js`, add to the imports block (next to other `* as handlers`):

```js
import * as giveawayButtons from '../handlers/giveawayButtons.js';
```

- [ ] **Step 2: Add prefix routing**

In the button branch, after the `cr_panel:` block (around line 204):

```js
      if (!handler && interaction.customId.startsWith('giveaway_enter:')) {
        handler = giveawayButtons.handleEnter;
      }
      if (!handler && interaction.customId.startsWith('giveaway_vote:')) {
        handler = giveawayButtons.handleVote;
      }
```

- [ ] **Step 3: Boot dev to verify wiring loads**

Run: `bun run start`. Expected: bot logs `Logged in as ...` with no module-load errors. Ctrl+C.

- [ ] **Step 4: Commit**

```bash
git add src/events/interactionCreate.js
git commit -m "feat(giveaway): wire giveaway button handlers"
```

---

## Task 21: Register slash command with Discord

**Files:**
- No file changes — Discord API registration

- [ ] **Step 1: Re-register commands**

Run: `bun run deploy-commands`

Expected: stdout reports successful registration; `/giveaway` and its subcommands appear in the dev guild within a minute.

- [ ] **Step 2: Verify in Discord**

In the dev guild, type `/giveaway` in any channel. Expected: autocomplete shows the six subcommands.

- [ ] **Step 3: No commit needed** (deploy-commands only registers; no files change.)

---

## Task 22: Manual integration test on staging

**Files:**
- None — manual QA in staging guild

- [ ] **Step 1: Switch bot to staging environment**

Per existing convention, staging runs from the `staging` branch. Merge or cherry-pick `feat/giveaway-system` onto `staging` only after the steps below pass in dev.

For now, run the test in **dev** first.

- [ ] **Step 2: Run through the test plan**

In dev, manually walk through:

1. `/giveaway start prize:"Test Prize" channel:#bot-testing` — entry embed posts with Enter button.
2. As a user with linked Steam (you): click Enter → ephemeral confirms with ticket count, OR rejects with playtime message if you have <5h on dev.
3. As a user without a linked Steam (alt account or unlinked test): click Enter → "Link Steam first" message.
4. `/giveaway add-entry user:@TestAlt hours:50 seed:10` → success.
5. `/giveaway leaderboard` → ephemeral shows you + TestAlt with computed tickets.
6. `/giveaway open-vote` (defaults to entry channel) → vote message posts with 2 buttons.
7. Click your own name button → "cannot vote for yourself".
8. Click TestAlt button → "Vote recorded, 1 vote left".
9. Click TestAlt button again → "already voted for this entrant".
10. Click your name (from a second voter account if available) → vote recorded.
11. `/giveaway draw` → winner embed posts; status moves to `drawn`.
12. `/giveaway draw` again → "Already drawn" error.
13. `/giveaway start` again with new prize → fresh entry post; previous draw doesn't block.
14. `/giveaway cancel` → entry message deleted, giveaway marked cancelled.

- [ ] **Step 3: Inspect DB state**

```powershell
mariadb -h $env:DB_HOST -u $env:DB_USER -p"$env:DB_PASSWORD" Royal_secretary -e "SELECT id, prize, status, winner_user_id FROM giveaways ORDER BY id DESC LIMIT 5"
```

Expected: rows showing the lifecycle transitions you ran above (`open` → `voting` → `drawn`, plus a `cancelled` row).

- [ ] **Step 4: No commit** (manual test only).

---

## Task 23: Version bump + push

**Files:**
- Modify: `package.json` (version field)

Per [feedback_semver_bump_on_push](feedback_semver_bump_on_push): bump bot semver on every push.

- [ ] **Step 1: Bump minor version**

This is a feature addition (not breaking, not just a fix), so bump minor: `2.4.1` → `2.5.0`.

Edit `package.json`:

```diff
-  "version": "2.4.1",
+  "version": "2.5.0",
```

- [ ] **Step 2: Commit and push branch**

```bash
git add package.json
git commit -m "chore: bump version to 2.5.0"
git push -u origin feat/giveaway-system
```

Expected: branch pushed; ready for PR or direct merge to `staging` per your normal deploy flow.

- [ ] **Step 3: Open PR or merge** (manual — your call on staging vs production merge cadence).

---

## Summary

23 tasks, ordered for incremental commit-and-verify. Pure logic (Tasks 3-4) has full TDD; service/handler/command code uses smoke imports + a Task 22 staging walkthrough as the integration safety net (matches the repo's existing zero-unit-test convention while still covering the math that actually matters).

Feature complete after Task 23. Phase 2 work (self-serve Steam linking, community-wide scope) is intentionally out of scope per the spec.
