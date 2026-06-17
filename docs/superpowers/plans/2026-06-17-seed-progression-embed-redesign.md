# Seed Progression Embed Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the public seed-progression Discord embed with a milestone track, a Steam-avatar thumbnail (DB-cached by hash), and a rolling-window "Seed again by" deadline, and hide the unpolished Quality metric from public surfaces.

**Architecture:** Pure render helpers (`buildMilestoneTrack`, `buildAvatarUrl`, `isAvatarFresh`) plus a cache-aware `getAvatarUrl` orchestrator in `steamService.js` backed by a new `steam_avatar_cache` table. The public embed builder switches to an options object; the leaderboard drops Quality. The private DM embed is left untouched (currently unreachable).

**Tech Stack:** Bun, discord.js v14 (`EmbedBuilder`), MariaDB (`mariadb` pool via `query()`), `bun:test`.

**Spec:** `docs/superpowers/specs/2026-06-17-seed-progression-embed-redesign-design.md`

---

## File Structure

- `src/services/seedTracker/seedTrackerEmbeds.js` — add `buildMilestoneTrack`; rework `buildProgressionEmbed`; trim `buildLeaderboardEmbed`. Keep `buildProgressBar`, `formatQuality`, `buildDmProgressionEmbed` (DM path).
- `src/services/steamService.js` — add `avatarHash` to `getSteamProfile`; add `AVATAR_REFRESH_DAYS`, `buildAvatarUrl`, `isAvatarFresh`, `getCachedAvatar`, `upsertCachedAvatar`, `getAvatarUrl`.
- `src/database/schema.js` — add `steam_avatar_cache` table.
- `src/services/seedTracker/seedTrackerService.js` — `getPlayerSeedStats` returns `firstSeedDate`; `processCompletedSession` resolves avatar + deadline and calls the new builder signature.
- Tests: `src/services/seedTracker/__tests__/seedTrackerEmbeds.test.js`, `src/services/__tests__/steamService.test.js` (new).

---

### Task 1: `buildMilestoneTrack` renderer

**Files:**
- Modify: `src/services/seedTracker/seedTrackerEmbeds.js`
- Test: `src/services/seedTracker/__tests__/seedTrackerEmbeds.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `src/services/seedTracker/__tests__/seedTrackerEmbeds.test.js`:

```js
import { describe, test, expect } from 'bun:test';
import { buildMilestoneTrack } from '../seedTrackerEmbeds.js';

describe('buildMilestoneTrack', () => {
  test('empty progress: halfway/goal shown unfilled', () => {
    expect(buildMilestoneTrack(0, 10)).toBe('○━○━○━○━◇━○━○━○━○━◎');
  });

  test('halfway reached fills the halfway diamond', () => {
    expect(buildMilestoneTrack(5, 10)).toBe('●━●━●━●━◆━○━○━○━○━◎');
  });

  test('goal reached fills the goal marker', () => {
    expect(buildMilestoneTrack(10, 10)).toBe('●━●━●━●━◆━●━●━●━●━◉');
  });

  test('done is clamped to total', () => {
    expect(buildMilestoneTrack(12, 10)).toBe(buildMilestoneTrack(10, 10));
  });

  test('non-default total places halfway at floor(total/2)', () => {
    expect(buildMilestoneTrack(3, 7)).toBe('●━●━◆━○━○━○━◎');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/seedTracker/__tests__/seedTrackerEmbeds.test.js`
Expected: FAIL — `buildMilestoneTrack` is not exported.

- [ ] **Step 3: Implement `buildMilestoneTrack`**

In `src/services/seedTracker/seedTrackerEmbeds.js`, add after the existing `buildProgressBar` function (keep `buildProgressBar` — the DM embed still uses it):

```js
const TRACK_GLYPH = {
  doneDay: '●', remainDay: '○',
  doneHalf: '◆', remainHalf: '◇',
  doneGoal: '◉', remainGoal: '◎',
};

export function buildMilestoneTrack(done, total) {
  const filled = Math.max(0, Math.min(done, total));
  const halfwayIdx = Math.floor(total / 2);
  const nodes = [];
  for (let i = 1; i <= total; i++) {
    const reached = i <= filled;
    let glyph;
    if (i === total) glyph = reached ? TRACK_GLYPH.doneGoal : TRACK_GLYPH.remainGoal;
    else if (i === halfwayIdx) glyph = reached ? TRACK_GLYPH.doneHalf : TRACK_GLYPH.remainHalf;
    else glyph = reached ? TRACK_GLYPH.doneDay : TRACK_GLYPH.remainDay;
    nodes.push(glyph);
  }
  return nodes.join('━');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/services/seedTracker/__tests__/seedTrackerEmbeds.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/seedTracker/seedTrackerEmbeds.js src/services/seedTracker/__tests__/seedTrackerEmbeds.test.js
git commit -m "feat(seeding): add milestone-track renderer for seed progress"
```

---

### Task 2: Steam avatar pure helpers

**Files:**
- Modify: `src/services/steamService.js`
- Test: `src/services/__tests__/steamService.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `src/services/__tests__/steamService.test.js`:

```js
import { describe, test, expect } from 'bun:test';
import { buildAvatarUrl, isAvatarFresh, AVATAR_REFRESH_DAYS } from '../steamService.js';

const DAY = 86400000;
const NOW = 1_700_000_000_000;

describe('buildAvatarUrl', () => {
  test('builds the full-size CDN url from a hash', () => {
    expect(buildAvatarUrl('abc123')).toBe('https://avatars.steamstatic.com/abc123_full.jpg');
  });
  test('returns null for a missing hash', () => {
    expect(buildAvatarUrl(null)).toBeNull();
  });
});

describe('isAvatarFresh', () => {
  test('fresh within the refresh window', () => {
    expect(isAvatarFresh(new Date(NOW - 5 * DAY), NOW)).toBe(true);
  });
  test('stale past the refresh window', () => {
    expect(isAvatarFresh(new Date(NOW - (AVATAR_REFRESH_DAYS + 1) * DAY), NOW)).toBe(false);
  });
  test('null last-checked is never fresh', () => {
    expect(isAvatarFresh(null, NOW)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/__tests__/steamService.test.js`
Expected: FAIL — exports not defined.

- [ ] **Step 3: Implement the helpers**

In `src/services/steamService.js`, add near the top (after `const STEAM_API_BASE = ...`):

```js
const AVATAR_CDN_BASE = 'https://avatars.steamstatic.com';
export const AVATAR_REFRESH_DAYS = 30;

export function buildAvatarUrl(hash) {
  return hash ? `${AVATAR_CDN_BASE}/${hash}_full.jpg` : null;
}

export function isAvatarFresh(lastCheckedAt, nowMs, refreshDays = AVATAR_REFRESH_DAYS) {
  if (!lastCheckedAt) return false;
  return (nowMs - new Date(lastCheckedAt).getTime()) < refreshDays * DAY_MS;
}
```

Add the millisecond constant near the other module constants:

```js
const DAY_MS = 86400000;
```

And in `getSteamProfile`, add `avatarHash` to the returned object (the `GetPlayerSummaries` response already contains `avatarhash`):

```js
    return {
      personaName: player.personaname || null,
      profileUrl: player.profileurl || null,
      visibility: player.communityvisibilitystate === 3 ? 'public' : 'private',
      accountCreated: player.timecreated ? new Date(player.timecreated * 1000).toISOString().slice(0, 10) : null,
      avatarHash: player.avatarhash || null,
    };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/services/__tests__/steamService.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/steamService.js src/services/__tests__/steamService.test.js
git commit -m "feat(steam): add avatar url/freshness helpers and expose avatarHash"
```

---

### Task 3: `steam_avatar_cache` table

**Files:**
- Modify: `src/database/schema.js`

- [ ] **Step 1: Add the table**

In `src/database/schema.js`, add a new block immediately after the `bot_state` `CREATE TABLE` block (lines ~11-17):

```js
  // Steam avatar cache: store only the avatar hash (the CDN url is reconstructable
  // from it) plus first/last cache times. Refreshed every AVATAR_REFRESH_DAYS.
  await query(`
    CREATE TABLE IF NOT EXISTS steam_avatar_cache (
      steam_id        VARCHAR(20) NOT NULL PRIMARY KEY,
      avatar_hash     CHAR(40)    NOT NULL,
      first_cached_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_checked_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
```

(Deliberately no `ON UPDATE CURRENT_TIMESTAMP` on `last_checked_at` — the upsert sets it explicitly so an unchanged hash still re-bumps the freshness clock.)

- [ ] **Step 2: Verify the schema file still loads**

Run: `bun -e "await import('./src/database/schema.js'); console.log('ok')"`
Expected: prints `ok` (module parses; no DB connection needed for import).

- [ ] **Step 3: Commit**

```bash
git add src/database/schema.js
git commit -m "feat(db): add steam_avatar_cache table"
```

---

### Task 4: Cache-aware `getAvatarUrl` orchestrator

**Files:**
- Modify: `src/services/steamService.js`

- [ ] **Step 1: Implement cache helpers + orchestrator**

In `src/services/steamService.js`, add the `query` import at the top with the other imports:

```js
import { query } from '../database/connection.js';
```

Then add (after `getSteamProfile`):

```js
async function getCachedAvatar(steamId) {
  const rows = await query(
    'SELECT avatar_hash AS avatarHash, last_checked_at AS lastCheckedAt FROM steam_avatar_cache WHERE steam_id = ? LIMIT 1',
    [steamId]
  );
  return rows[0] || null;
}

async function upsertCachedAvatar(steamId, hash) {
  await query(
    `INSERT INTO steam_avatar_cache (steam_id, avatar_hash) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE avatar_hash = VALUES(avatar_hash), last_checked_at = NOW()`,
    [steamId, hash]
  );
}

/**
 * Resolve a player's avatar url, cached by hash in steam_avatar_cache.
 * Fresh hit -> no API call. Stale/miss -> refresh from API + upsert.
 * API failure with a stale row -> serve the stale url. Otherwise null.
 */
export async function getAvatarUrl(steamId) {
  let cached = null;
  try {
    cached = await getCachedAvatar(steamId);
  } catch (err) {
    log.warn({ err: err.message, steamId }, 'Steam: avatar cache read failed');
  }

  if (cached && isAvatarFresh(cached.lastCheckedAt, Date.now())) {
    return buildAvatarUrl(cached.avatarHash);
  }

  const profile = await getSteamProfile(steamId);
  if (profile?.avatarHash) {
    try {
      await upsertCachedAvatar(steamId, profile.avatarHash);
    } catch (err) {
      log.warn({ err: err.message, steamId }, 'Steam: avatar cache write failed');
    }
    return buildAvatarUrl(profile.avatarHash);
  }

  if (cached?.avatarHash) return buildAvatarUrl(cached.avatarHash);
  return null;
}
```

- [ ] **Step 2: Verify the module still parses and existing tests pass**

Run: `bun test src/services/__tests__/steamService.test.js`
Expected: PASS (still 5 tests; no regressions).

- [ ] **Step 3: Commit**

```bash
git add src/services/steamService.js
git commit -m "feat(steam): cache-aware getAvatarUrl backed by steam_avatar_cache"
```

---

### Task 5: `getPlayerSeedStats` returns `firstSeedDate`

**Files:**
- Modify: `src/services/seedTracker/seedTrackerService.js:16-43`

- [ ] **Step 1: Add `MIN(seed_date)` to the query and return it**

In `getPlayerSeedStats`, add the column to the SELECT list (after the `COUNT(DISTINCT ...)` line):

```js
        MIN(s.seed_date) AS firstSeedDate,
```

And add it to both returned objects:

```js
    return {
      uniqueDays: Number(row.uniqueDays) || 0,
      avgQuality: row.avgQuality != null ? Number(row.avgQuality) : null,
      lastSeedDate: row.lastSeedDate || null,
      firstSeedDate: row.firstSeedDate || null,
      totalDuration: Number(row.totalDuration) || 0,
    };
```

And the catch-block fallback:

```js
    return { uniqueDays: 0, avgQuality: null, lastSeedDate: null, firstSeedDate: null, totalDuration: 0 };
```

- [ ] **Step 2: Verify the full suite still passes**

Run: `bun test`
Expected: PASS (no regressions; additive change).

- [ ] **Step 3: Commit**

```bash
git add src/services/seedTracker/seedTrackerService.js
git commit -m "feat(seeding): expose firstSeedDate from getPlayerSeedStats"
```

---

### Task 6: Redesign `buildProgressionEmbed`

**Files:**
- Modify: `src/services/seedTracker/seedTrackerEmbeds.js:24-36`
- Test: `src/services/seedTracker/__tests__/seedTrackerEmbeds.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `seedTrackerEmbeds.test.js`:

```js
import { buildProgressionEmbed } from '../seedTrackerEmbeds.js';

const fieldNames = (embed) => embed.data.fields.map((f) => f.name);

describe('buildProgressionEmbed', () => {
  const base = { name: 'Jonas', steamId: '76561198000000000', uniqueDays: 5, required: 10, streak: 3 };

  test('renders the milestone track and day count, no legend', () => {
    const e = buildProgressionEmbed({ ...base });
    expect(e.data.description).toContain('●━●━●━●━◆━○━○━○━○━◎');
    expect(e.data.description).toContain('5 / 10 days');
    expect(e.data.description).not.toContain('halfway');
  });

  test('has no Quality field', () => {
    const e = buildProgressionEmbed({ ...base });
    expect(fieldNames(e)).not.toContain('Quality');
  });

  test('shows Seed again by when a deadline is given', () => {
    const e = buildProgressionEmbed({ ...base, seedAgainBy: new Date(1_700_000_000_000) });
    expect(fieldNames(e)).toContain('Seed again by');
    const field = e.data.fields.find((f) => f.name === 'Seed again by');
    expect(field.value).toContain('<t:');
  });

  test('omits Seed again by when no deadline', () => {
    const e = buildProgressionEmbed({ ...base, seedAgainBy: null });
    expect(fieldNames(e)).not.toContain('Seed again by');
  });

  test('sets the avatar thumbnail when provided', () => {
    const e = buildProgressionEmbed({ ...base, avatarUrl: 'https://avatars.steamstatic.com/x_full.jpg' });
    expect(e.data.thumbnail?.url).toBe('https://avatars.steamstatic.com/x_full.jpg');
  });

  test('omits the thumbnail when no avatar', () => {
    const e = buildProgressionEmbed({ ...base });
    expect(e.data.thumbnail).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/services/seedTracker/__tests__/seedTrackerEmbeds.test.js`
Expected: FAIL — the current `buildProgressionEmbed` takes positional args and has a Quality field.

- [ ] **Step 3: Rewrite `buildProgressionEmbed`**

Replace the existing `buildProgressionEmbed` (lines 24-36) with:

```js
export function buildProgressionEmbed({ name, steamId, uniqueDays, required, streak, avatarUrl = null, seedAgainBy = null }) {
  const done = Math.max(0, Math.min(uniqueDays, required));
  const track = buildMilestoneTrack(uniqueDays, required);

  const embed = createEmbed('Seed Tracker')
    .setColor(COLOR_INFO)
    .setTitle('Seed Progress')
    .setDescription(`**${name}**\n\`${track}\`\n**${done} / ${required} days**`);

  if (avatarUrl) embed.setThumbnail(avatarUrl);

  const fields = [
    { name: 'Streak', value: `${streak} day${streak !== 1 ? 's' : ''}`, inline: true },
  ];
  if (seedAgainBy) {
    fields.push({ name: 'Seed again by', value: discordTimestamp(seedAgainBy, 'R'), inline: true });
  }
  fields.push({ name: 'Steam ID', value: steamId, inline: false });
  embed.addFields(...fields);

  return embed;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/services/seedTracker/__tests__/seedTrackerEmbeds.test.js`
Expected: PASS (milestone-track + progression tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/seedTracker/seedTrackerEmbeds.js src/services/seedTracker/__tests__/seedTrackerEmbeds.test.js
git commit -m "feat(seeding): redesign public seed-progress embed (track, avatar, deadline; drop quality)"
```

---

### Task 7: Drop Quality from the public leaderboard

**Files:**
- Modify: `src/services/seedTracker/seedTrackerEmbeds.js:58-70`
- Test: `src/services/seedTracker/__tests__/seedTrackerEmbeds.test.js`

- [ ] **Step 1: Write the failing test**

Append to `seedTrackerEmbeds.test.js`:

```js
import { buildLeaderboardEmbed } from '../seedTrackerEmbeds.js';

describe('buildLeaderboardEmbed', () => {
  test('lines do not expose Quality', () => {
    const e = buildLeaderboardEmbed(
      [{ name: 'Jonas', seedDays: 8, totalDuration: 3600, avgQuality: 0.9 }],
      30
    );
    expect(e.data.description).not.toContain('Quality');
    expect(e.data.description).toContain('Jonas');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/seedTracker/__tests__/seedTrackerEmbeds.test.js`
Expected: FAIL — current lines include `| Quality: ...`.

- [ ] **Step 3: Remove the Quality segment**

In `buildLeaderboardEmbed`, drop the `quality` line and the segment:

```js
  const lines = seeders.map((s, i) => {
    const rank = i + 1;
    const duration = formatDuration(s.totalDuration);
    return `**#${rank}** ${s.name} - ${s.seedDays} days | ${duration}`;
  });
```

(Leave `formatQuality` defined — `buildDmProgressionEmbed` still uses it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/services/seedTracker/__tests__/seedTrackerEmbeds.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/seedTracker/seedTrackerEmbeds.js src/services/seedTracker/__tests__/seedTrackerEmbeds.test.js
git commit -m "feat(seeding): hide quality from public leaderboard"
```

---

### Task 8: Wire avatar + deadline into `processCompletedSession`

**Files:**
- Modify: `src/services/seedTracker/seedTrackerService.js` (imports + progression branch ~176-184)

- [ ] **Step 1: Add the import**

At the top of `seedTrackerService.js`, add:

```js
import { getAvatarUrl } from '../steamService.js';
```

- [ ] **Step 2: Update the progression branch**

Replace the `// progression` block (currently lines ~176-184) with:

```js
    // progression
    const channelId = cfg.progression_channel_id;
    if (!channelId) return;
    const streak = await getSeedStreak(data.steamID, serverId);
    const avatarUrl = await getAvatarUrl(data.steamID);
    const seedAgainBy = stats.firstSeedDate
      ? new Date(new Date(stats.firstSeedDate).getTime() + windowDays * 86400000)
      : null;
    const embed = buildProgressionEmbed({
      name: data.playerName,
      steamId: data.steamID,
      uniqueDays: stats.uniqueDays,
      required: requiredDays,
      streak,
      avatarUrl,
      seedAgainBy,
    });
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel) await channel.send({ embeds: [embed] });
```

(`windowDays` and `requiredDays` are already in scope from earlier in the function.)

- [ ] **Step 3: Run the full suite**

Run: `bun test`
Expected: PASS (all suites green).

- [ ] **Step 4: Commit**

```bash
git add src/services/seedTracker/seedTrackerService.js
git commit -m "feat(seeding): post avatar + seed-again-by deadline on progression"
```

---

### Task 9: Version bump + final verification

**Files:**
- Modify: `package.json:3`

- [ ] **Step 1: Bump the minor version**

Change `"version": "2.14.0"` to `"version": "2.15.0"` in `package.json`.

- [ ] **Step 2: Run the full test suite**

Run: `bun test`
Expected: PASS — all suites, including the new milestone-track, steamService, progression, and leaderboard tests.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: bump version to 2.15.0"
```

---

### Task 10: Deploy to staging, then production

Reference: deploy-branch-mapping memory — bot push `main` = staging; merge `main` -> `production` = prod (a real merge commit; FF-only push is rejected). Verify with `gh run list`.

- [ ] **Step 1: Confirm branch + clean tree**

Run: `git status -sb` and `git branch --show-current`
Expected: on `main`, working tree clean (all tasks committed).

- [ ] **Step 2: Push to staging**

Run: `git push origin main`
Then: `gh run list --branch main --limit 3`
Expected: a new workflow run kicked off; wait for it to go green (`gh run watch` or re-list).

- [ ] **Step 3: Merge to production**

```bash
git checkout production
git pull origin production
git merge --no-ff main -m "chore: release 2.15.0 — seed progression embed redesign"
git push origin production
git checkout main
```

- [ ] **Step 4: Verify prod deploy**

Run: `gh run list --branch production --limit 3`
Expected: production workflow run is green (build + deploy). Confirm the container reports `Up` if the deploy logs are reachable.

- [ ] **Step 5: Post-deploy sanity**

The `steam_avatar_cache` table is created idempotently on boot by `schema.js`. After the prod container restarts, the next completed seed session posts the redesigned embed; confirm the boot log line shows no schema errors.

---

## Notes

- The private/ephemeral DM embed (`buildDmProgressionEmbed`) and its handler are intentionally untouched (currently unreachable). `buildProgressBar` and `formatQuality` remain because that path still uses them.
- Steam avatar host is a fixed constant (`https://avatars.steamstatic.com`); if Steam ever changes its CDN host, update `AVATAR_CDN_BASE` in `steamService.js`.
