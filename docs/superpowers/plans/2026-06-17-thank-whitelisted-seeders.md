# Thank Whitelisted Seeders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Post a once-per-day public "thank you" to whitelist holders (everyone except Seeder-reward holders) who help seed, in a new website-configurable channel.

**Architecture:** Bot side flips the existing `skip` branch for non-Seeder whitelist holders into a new `thank` action; a pure `shouldThankToday` helper plus a `seed_thanks` table enforce once-per-day; a new embed is posted to `appreciation_channel_id`. Website side adds that channel as a config field. The bot must deploy first (it creates the new column + table on boot) before the website, which reads/writes the column.

**Tech Stack:** Bot — Bun, discord.js v14, MariaDB (`query` helper), bun:test. Website — Hono API, Prisma raw SQL, Next.js/React, shared TS types.

**Spec:** `docs/superpowers/specs/2026-06-17-thank-whitelisted-seeders-design.md`

---

## Part A — Bot (`RoyalSecretaryDiscordBot`, branch `main`)

Deploy Part A fully (to prod) before starting Part B: `schema.js` creates the
`appreciation_channel_id` column and `seed_thanks` table on boot, which the
website depends on.

### Task A1: DB schema — column + table

**Files:**
- Modify: `src/database/schema.js` (after line 307, the `leaderboard_channel_id` ALTER)

- [ ] **Step 1: Add the column and table**

After the `leaderboard_channel_id` ALTER statement, add:

```js
  await query(`ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS appreciation_channel_id VARCHAR(20) NULL`);

  await query(`
    CREATE TABLE IF NOT EXISTS seed_thanks (
      steam_id VARCHAR(20) NOT NULL PRIMARY KEY,
      player_name VARCHAR(255) NULL,
      last_thanked_date DATE NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
```

- [ ] **Step 2: Verify it parses**

Run: `bun -e "await import('./src/database/schema.js')"`
Expected: no import/parse error (it will not connect to a DB; we are only
checking the module loads).

- [ ] **Step 3: Commit**

```bash
git add src/database/schema.js
git commit -m "feat(seed-tracker): add appreciation_channel_id column and seed_thanks table"
```

### Task A2: `decideSeederAction` returns `thank` for non-Seeder whitelist

**Files:**
- Modify: `src/services/seedTracker/seederRewardLogic.js:14-16`
- Test: `src/services/seedTracker/__tests__/seederRewardLogic.test.js:9-12`

- [ ] **Step 1: Update the failing test**

Replace the existing `'non-Seeder whitelist is always skipped'` test (lines 9-12)
with:

```js
  test('non-Seeder whitelist (clan/admin) => thank', () => {
    const r = decideSeederAction({ ...base, uniqueDays: 99, whitelist: { role: 'Admin', expiresAt: null } });
    expect(r.action).toBe('thank');
  });

  test('non-Seeder whitelist below threshold also => thank', () => {
    const r = decideSeederAction({ ...base, uniqueDays: 1, whitelist: { role: 'Clan', expiresAt: new Date(NOW + 5 * DAY) } });
    expect(r.action).toBe('thank');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/seedTracker/__tests__/seederRewardLogic.test.js`
Expected: FAIL — the two new tests expect `thank` but the code returns `skip`.

- [ ] **Step 3: Change the logic**

In `seederRewardLogic.js`, update the JSDoc `@returns` union and line 16:

```js
 * @returns {{action: 'skip'|'progression'|'grant'|'extend'|'thank', expiresAt?: Date}}
```

```js
  // Active non-Seeder whitelist (clan, admin, donor, etc.) — thank them for helping seed.
  if (whitelist && whitelist.role !== 'Seeder') return { action: 'thank' };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/services/seedTracker/__tests__/seederRewardLogic.test.js`
Expected: PASS (all cases, including the unchanged Seeder/no-whitelist ones).

- [ ] **Step 5: Commit**

```bash
git add src/services/seedTracker/seederRewardLogic.js src/services/seedTracker/__tests__/seederRewardLogic.test.js
git commit -m "feat(seed-tracker): thank non-Seeder whitelist holders instead of skipping"
```

### Task A3: `shouldThankToday` once-per-day helper

**Files:**
- Modify: `src/services/seedTracker/seederRewardLogic.js` (append function)
- Test: `src/services/seedTracker/__tests__/seederRewardLogic.test.js` (append describe block; update import on line 2)

- [ ] **Step 1: Write the failing test**

Update the import on line 2:

```js
import { decideSeederAction, shouldThankToday } from '../seederRewardLogic.js';
```

Append after the `decideSeederAction` describe block:

```js
describe('shouldThankToday', () => {
  test('null last date => thank', () => {
    expect(shouldThankToday(null, '2026-06-17')).toBe(true);
  });

  test('earlier date => thank', () => {
    expect(shouldThankToday('2026-06-16', '2026-06-17')).toBe(true);
  });

  test('same date => do not thank', () => {
    expect(shouldThankToday('2026-06-17', '2026-06-17')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/seedTracker/__tests__/seederRewardLogic.test.js`
Expected: FAIL — `shouldThankToday is not a function`.

- [ ] **Step 3: Implement the helper**

Append to `seederRewardLogic.js`:

```js
/**
 * Once-per-day gate for the seeder thank-you. Pure equality of YYYY-MM-DD
 * strings (both computed in the same timezone by the caller).
 * @param {string|null} lastThankedDate  last date we thanked this player (YYYY-MM-DD) or null
 * @param {string} today                 today's date (YYYY-MM-DD)
 * @returns {boolean} true if we should thank now
 */
export function shouldThankToday(lastThankedDate, today) {
  return !lastThankedDate || lastThankedDate !== today;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/services/seedTracker/__tests__/seederRewardLogic.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/seedTracker/seederRewardLogic.js src/services/seedTracker/__tests__/seederRewardLogic.test.js
git commit -m "feat(seed-tracker): add shouldThankToday once-per-day helper"
```

### Task A4: `buildSeederThanksEmbed`

**Files:**
- Modify: `src/services/seedTracker/seedTrackerEmbeds.js` (append export; `createEmbed` and `COLOR_SUCCESS` already exist at the top of this file)
- Test: `src/services/seedTracker/__tests__/seedTrackerEmbeds.test.js` (append describe; update import on line 2)

- [ ] **Step 1: Write the failing test**

Update the import on line 2 to include the new builder:

```js
import { buildMilestoneTrack, buildProgressionEmbed, buildLeaderboardEmbed, buildSeederThanksEmbed } from '../seedTrackerEmbeds.js';
```

Append a new describe block at the end of the file:

```js
describe('buildSeederThanksEmbed', () => {
  test('renders a thank-you with the name and no stats', () => {
    const e = buildSeederThanksEmbed({ name: 'Anders' });
    expect(e.data.title).toBe('Thanks for seeding!');
    expect(e.data.description).toContain('Anders');
    expect(e.data.thumbnail).toBeUndefined();
    expect(e.data.fields ?? []).toHaveLength(0);
  });

  test('sets the thumbnail when an avatar is provided', () => {
    const e = buildSeederThanksEmbed({ name: 'Anders', avatarUrl: 'https://avatars.steamstatic.com/x_full.jpg' });
    expect(e.data.thumbnail?.url).toBe('https://avatars.steamstatic.com/x_full.jpg');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/seedTracker/__tests__/seedTrackerEmbeds.test.js`
Expected: FAIL — `buildSeederThanksEmbed is not a function`.

- [ ] **Step 3: Implement the embed**

Append to `seedTrackerEmbeds.js`:

```js
export function buildSeederThanksEmbed({ name, avatarUrl = null }) {
  const embed = createEmbed('Seed Tracker')
    .setColor(COLOR_SUCCESS)
    .setTitle('Thanks for seeding!')
    .setDescription(`**${name}** helped seed the server today. Thanks for getting the round started!`);
  if (avatarUrl) embed.setThumbnail(avatarUrl);
  return embed;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/services/seedTracker/__tests__/seedTrackerEmbeds.test.js`
Expected: PASS (existing track/progression tests still pass).

- [ ] **Step 5: Commit**

```bash
git add src/services/seedTracker/seedTrackerEmbeds.js src/services/seedTracker/__tests__/seedTrackerEmbeds.test.js
git commit -m "feat(seed-tracker): add seeder thank-you embed"
```

### Task A5: `seed_thanks` accessors

**Files:**
- Modify: `src/services/seedTracker/seedTrackerService.js` (append two exported functions; `query` is already imported on line 1, `log` is defined on line 15)

- [ ] **Step 1: Add the accessors**

Append after the existing functions in `seedTrackerService.js`:

```js
export async function getLastThankedDate(steamId) {
  try {
    const rows = await query(
      `SELECT DATE_FORMAT(last_thanked_date, '%Y-%m-%d') AS lastThankedDate
       FROM seed_thanks WHERE steam_id = ? LIMIT 1`,
      [steamId]
    );
    return rows[0]?.lastThankedDate || null;
  } catch (err) {
    log.warn({ err, steamId }, 'Failed to read seed_thanks');
    return null;
  }
}

export async function recordThanked(steamId, name, dateStr) {
  await query(
    `INSERT INTO seed_thanks (steam_id, player_name, last_thanked_date)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE player_name = VALUES(player_name), last_thanked_date = VALUES(last_thanked_date)`,
    [steamId, name, dateStr]
  );
}
```

Note: `DATE_FORMAT(...)` returns the date as a `YYYY-MM-DD` **string**, so it
compares cleanly with `getTodayDate()` (no JS `Date` driver ambiguity).

- [ ] **Step 2: Verify the file parses**

Run: `bun -e "await import('./src/services/seedTracker/seedTrackerService.js')"`
Expected: no parse/import error.

- [ ] **Step 3: Commit**

```bash
git add src/services/seedTracker/seedTrackerService.js
git commit -m "feat(seed-tracker): add seed_thanks accessors"
```

### Task A6: Wire the thank-you into the session flow + version bump

**Files:**
- Modify: `src/services/seeding/seedingScheduler.js:74` (export `getTodayDate`)
- Modify: `src/services/seedTracker/seedTrackerService.js` (imports + new helper + new branch in `processCompletedSession`)
- Modify: `package.json` (version bump)

- [ ] **Step 1: Export `getTodayDate`**

In `seedingScheduler.js` line 74, add `export`:

```js
export function getTodayDate(timezone) {
```

(Runtime-only use in the tracker service, so even a module cycle is harmless —
the function is called at request time, not at module load.)

- [ ] **Step 2: Update imports in `seedTrackerService.js`**

Add `buildSeederThanksEmbed` to the embeds import (lines 4-9):

```js
import {
  buildProgressionEmbed,
  buildMilestoneEmbed,
  buildWhitelistGrantedEmbed,
  buildDmWhitelistNotification,
  buildSeederThanksEmbed,
} from './seedTrackerEmbeds.js';
```

Add `shouldThankToday` to the logic import (line 12) and import `getTodayDate`:

```js
import { decideSeederAction, shouldThankToday } from './seederRewardLogic.js';
import { getTodayDate } from '../seeding/seedingScheduler.js';
```

- [ ] **Step 3: Add the `thankWhitelistedSeeder` helper**

Add this function in `seedTrackerService.js` (e.g. just above `processCompletedSession`):

```js
async function thankWhitelistedSeeder(data, cfg, client) {
  const channelId = cfg.appreciation_channel_id;
  if (!channelId) return;

  const tz = cfg.timezone || 'UTC';
  const today = getTodayDate(tz);
  const lastThanked = await getLastThankedDate(data.steamID);
  if (!shouldThankToday(lastThanked, today)) return;

  const avatarUrl = await getAvatarUrl(data.steamID);
  const embed = buildSeederThanksEmbed({ name: data.playerName, avatarUrl });
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  await channel.send({ embeds: [embed] });
  await recordThanked(data.steamID, data.playerName, today);
}
```

- [ ] **Step 4: Add the `thank` branch in `processCompletedSession`**

In `processCompletedSession`, immediately after the `grant` branch (the block
ending `await grantSeederWhitelist(...); return; }` around line 177) and before
the `// progression` comment, insert:

```js
    if (decision.action === 'thank') {
      await thankWhitelistedSeeder(data, cfg, client);
      return;
    }
```

- [ ] **Step 5: Bump the bot version**

In `package.json`, bump the minor version (currently `2.17.0` -> `2.18.0`).

- [ ] **Step 6: Run the full seed-tracker test suite**

Run: `bun test src/services/seedTracker`
Expected: PASS (all decision, helper, and embed tests).

- [ ] **Step 7: Verify modules load**

Run: `bun -e "await import('./src/services/seedTracker/seedTrackerService.js')"`
Expected: no parse/import error.

- [ ] **Step 8: Commit**

```bash
git add package.json src/services/seeding/seedingScheduler.js src/services/seedTracker/seedTrackerService.js
git commit -m "feat(seed-tracker): post daily thank-you for whitelisted seeders"
```

### Task A7: Deploy the bot to prod

- [ ] **Step 1: Push main (staging) and confirm the working tree commit set**

```bash
git push origin main
git log --oneline origin/production..origin/main
```
Expected: the new `feat(seed-tracker)` commits listed. (Only commit the files
named above; leave any unrelated working-tree changes uncommitted.)

- [ ] **Step 2: Merge to production via a detached worktree (dirty-tree-safe)**

```bash
git fetch origin
git worktree add --detach ../rsb-prod-deploy origin/production
git -C ../rsb-prod-deploy merge origin/main --no-ff -m "Merge branch 'main' into production"
git -C ../rsb-prod-deploy push origin HEAD:production
git worktree remove --force ../rsb-prod-deploy ; git worktree prune
```

- [ ] **Step 3: Verify both deploys are green**

Run: `gh run list --limit 4`
Expected: "Deploy to Staging" (main) and "Deploy to Production" (production)
both `completed / success`.

- [ ] **Step 4: Confirm the column/table exist on prod (smoke)**

After the prod container is up, the boot log line `[boot] bot environment`
should appear without schema errors. The thank-you stays dormant until the
appreciation channel is set in Part B.

---

## Part B — Website (`RoyalBattalionWebpage`, off `origin/production`)

The local checkout is on a different branch, so do this work in a worktree off
`origin/production`. Only start after Part A is live on prod.

### Task B1: Branch setup

- [ ] **Step 1: Create a worktree off origin/production**

```bash
cd C:/Users/OleEd/Azure/RoyalBattalionWebpage
git fetch origin
git worktree add -b feat/appreciation-channel ../rbw-appreciation origin/production
```

All Part B edits happen in `../rbw-appreciation`.

### Task B2: Shared type

**Files:**
- Modify: `packages/shared/types/discord-bot.ts:18` (after `leaderboardChannelId`)

- [ ] **Step 1: Add the field**

After the `leaderboardChannelId: string | null;` line in the `SeedingConfig`
type, add:

```ts
  appreciationChannelId: string | null;
```

- [ ] **Step 2: Commit**

```bash
git -C ../rbw-appreciation add packages/shared/types/discord-bot.ts
git -C ../rbw-appreciation commit -m "feat(seeding): add appreciationChannelId to SeedingConfig type"
```

### Task B3: API route (GET + PUT)

**Files:**
- Modify: `packages/api/src/routes/discord-bot/seeding.ts` (GET select ~line 40, GET map ~line 72, PUT ~line 109)

- [ ] **Step 1: Add to the GET select**

Change the SELECT tail from:

```ts
               progression_channel_id, leaderboard_channel_id
```
to:
```ts
               progression_channel_id, leaderboard_channel_id, appreciation_channel_id
```

- [ ] **Step 2: Add to the GET response mapping**

After `leaderboardChannelId: r.leaderboard_channel_id,` add:

```ts
        appreciationChannelId: r.appreciation_channel_id,
```

- [ ] **Step 3: Add to the PUT update**

Change the last two SET lines from:

```ts
          progression_channel_id = ${body.progressionChannelId ?? null},
          leaderboard_channel_id = ${body.leaderboardChannelId ?? null}
```
to:
```ts
          progression_channel_id = ${body.progressionChannelId ?? null},
          leaderboard_channel_id = ${body.leaderboardChannelId ?? null},
          appreciation_channel_id = ${body.appreciationChannelId ?? null}
```

- [ ] **Step 4: Typecheck the API package**

Run: `cd ../rbw-appreciation && bun run --filter @rb/api typecheck`
(If that script does not exist, run the repo's standard typecheck/build for the
api package.)
Expected: no type errors for `seeding.ts`.

- [ ] **Step 5: Commit**

```bash
git -C ../rbw-appreciation add packages/api/src/routes/discord-bot/seeding.ts
git -C ../rbw-appreciation commit -m "feat(seeding): persist appreciation_channel_id in config endpoint"
```

### Task B4: Admin UI field

**Files:**
- Modify: `packages/web/app/(protected)/seeding/components/SeedingAdmin.tsx` (after the Leaderboard Channel block, ~line 402)

- [ ] **Step 1: Add the input block**

Immediately after the closing `</div>` of the `{/* Leaderboard Channel ID */}`
block, add:

```tsx
              {/* Appreciation Channel ID */}
              <div>
                <label className="mb-1 block text-xs font-medium tracking-[0.1em] text-text-muted uppercase">Seeder Appreciation Channel ID</label>
                <input
                  type="text"
                  value={editConfig.appreciationChannelId || ""}
                  onChange={(e) => setEditConfig({ ...editConfig, appreciationChannelId: e.target.value || null })}
                  placeholder="Discord channel ID"
                  className="w-full rounded-sm border border-border bg-bg-tertiary/50 px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent/50 focus:outline-none"
                />
              </div>
```

- [ ] **Step 2: Typecheck/build the web package**

Run: `cd ../rbw-appreciation && bun run --filter @rb/web build` (or the repo's
standard web typecheck).
Expected: builds without type errors (the `appreciationChannelId` field now
exists on `SeedingConfig`).

- [ ] **Step 3: Commit**

```bash
git -C ../rbw-appreciation add "packages/web/app/(protected)/seeding/components/SeedingAdmin.tsx"
git -C ../rbw-appreciation commit -m "feat(seeding): add Seeder Appreciation Channel field to admin UI"
```

### Task B5: Version bump + deploy

**Files:**
- Modify: `package.json` (root), `packages/api/package.json`, `packages/web/package.json`, `packages/shared/package.json`

- [ ] **Step 1: Bump versions**

Read each file's current `version` and bump the minor version of: the root
`package.json` and the three changed packages (`api`, `web`, `shared`).

- [ ] **Step 2: Commit**

```bash
git -C ../rbw-appreciation add package.json packages/api/package.json packages/web/package.json packages/shared/package.json
git -C ../rbw-appreciation commit -m "chore(release): bump for seeder appreciation channel"
```

- [ ] **Step 3: Deploy (push to production — Railway auto-build)**

```bash
git -C ../rbw-appreciation push origin HEAD:production
```
(Fast-forward push of a feature branch to `production` is allowed for the
webpage.)

- [ ] **Step 4: Clean up the worktree**

```bash
cd C:/Users/OleEd/Azure/RoyalBattalionWebpage
git worktree remove --force ../rbw-appreciation ; git worktree prune
```

- [ ] **Step 5: Verify**

Railway build takes ~3-8 min. Open the `/seeding` admin page and confirm the
"Seeder Appreciation Channel ID" field renders, save a channel ID, reload, and
confirm it persisted.

---

## End-to-end verification

- [ ] In the `/seeding` page, set the Seeder Appreciation Channel to a real
      channel ID and save.
- [ ] Have a non-Seeder whitelist holder (clan/admin) complete a seed session;
      confirm a single "Thanks for seeding!" embed appears in that channel.
- [ ] Confirm a second completed session by the same player on the same day does
      NOT post again (once-per-day).
- [ ] Confirm a Seeder-reward holder and a no-whitelist player still behave as
      before (no thank-you for them).

## Self-review notes

- Spec coverage: who-to-thank (A2), once-per-day (A1 table, A3 helper, A6 wire),
  new channel bot-side (A1, A6) + website-side (B2/B3/B4), embed (A4),
  testing (A2/A3/A4), versioning/deploy (A6/A7, B5). All covered.
- Deploy ordering: bot first (creates column+table), then website — called out
  in the Part A header and Part B intro.
- Type consistency: `appreciationChannelId` (camel, TS) / `appreciation_channel_id`
  (snake, SQL) used consistently; `getLastThankedDate`/`recordThanked`/
  `shouldThankToday`/`buildSeederThanksEmbed`/`thankWhitelistedSeeder`/
  `getTodayDate` names match across tasks.
