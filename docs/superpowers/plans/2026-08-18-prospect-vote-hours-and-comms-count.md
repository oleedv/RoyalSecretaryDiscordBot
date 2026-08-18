# Prospect vote hours + off-Discord count Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start prospect votes at 6h gameplay, still require 16h to accept, and show voters/staff/website how many times the prospect was caught in-game without Discord.

**Architecture:** Pure `prospectVoteRules.js` owns the 6h/16h predicates, deny reasons, warning copy, and off-Discord wording. `finalizeVote` and the scheduler call those helpers. Each comms-watch staff alert is inserted into `prospect_comms_alerts` (unique on Discord message id); the vote embed and website `COUNT(*)` that table. A startup backfill scans open staff tickets for the current and legacy alert titles.

**Tech Stack:** Bun, discord.js v14, MariaDB (`query()`), `bun:test`. Website: Hono + Prisma `$queryRaw` against the secretary DB, Next.js pages.

**Spec:** `docs/superpowers/specs/2026-08-18-prospect-vote-hours-and-comms-count-design.md`

## Global Constraints

- ESM only; parameterized SQL (`?`) in the bot. Website uses Prisma tagged SQL.
- Gameplay hours only (`getPlaytime().playtimeHours`). Seed hours never count.
- Defaults if config missing: `voteStartHours = 6`, `voteAcceptHours = 16`.
- Missing playtime (`null`) never blocks vote start and never denies on hours at end (staff warning instead).
- Test Steam IDs (`isTestSteamId` / `'Q'`) skip playtime entirely.
- Count = `COUNT(*)` from `prospect_comms_alerts`. No denormalized counter column.
- `INSERT IGNORE` on `discord_message_id`. Failed insert must not drop an already-posted staff alert.
- Vote-embed mid-vote refresh edits **embeds only** — never reset Yes/No/Unsure buttons.
- Conventional Commits, one line, no AI attribution, no emojis.
- Bot version bump last: `2.35.1` → `2.36.0`.
- Website work lives in sibling repo `RoyalBattalionWebpage` (workspace `C:\Users\OleEd\Azure\RoyalBattalionWebpage`).

## File Structure

- Create `src/services/prospect/prospectVoteRules.js` — pure hour/vote/copy helpers.
- Create `src/services/prospect/__tests__/prospectVoteRules.test.js`.
- Modify `src/services/prospect/prospectEmbeds.js` — hours-requirement field + Off Discord line.
- Modify `src/services/prospect/__tests__/prospectVoteEmbed.test.js`.
- Modify `src/database/schema.js` — `prospect_comms_alerts`.
- Modify `src/services/commsWatch/commsWatchEmbeds.js` — export title constants + `isCommsAlertTitle`.
- Modify `src/services/commsWatch/__tests__/commsWatchEmbeds.test.js` — title matcher cases.
- Modify `src/services/commsWatch/commsWatchService.js` — insert, count, backfill.
- Modify `src/services/commsWatch/commsWatchMonitor.js` — persist on alert; start backfill; refresh vote embed.
- Modify `src/services/prospect/prospectVoting.js` — `loadVoteStats`, `refreshVoteEmbed`, hours check in `finalizeVote`.
- Modify `src/services/prospect/prospectScheduler.js` — 6h start gate + staff copy.
- Modify `src/handlers/prospectButtons.js` — Force Vote accept-bar copy.
- Modify `settings.development.js`, `settings.staging.js`, `settings.production.js` — the two hour keys.
- Website: `packages/shared/types/tickets.ts`, `packages/api/src/routes/prospects.ts`, `packages/web/app/(protected)/tickets/page.tsx`, `packages/web/app/(public)/prospect/[uuid]/page.tsx`.
- Modify `package.json` — version only, last task.

Do not split existing large files. New logic that can be tested without Discord/DB goes in `prospectVoteRules.js`.

---

### Task 1: Pure vote hour rules

**Files:**
- Create: `src/services/prospect/prospectVoteRules.js`
- Test: `src/services/prospect/__tests__/prospectVoteRules.test.js`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `shouldSkipVoteStart(playtimeHours, voteStartHours)` → `boolean`. `true` only when `playtimeHours` is a number `< voteStartHours`.
  - `shouldShowHoursWarning(playtimeHours, voteAcceptHours)` → `boolean`. `true` only when `playtimeHours` is a number `< voteAcceptHours`.
  - `hoursWarningValue(voteAcceptHours)` → string using the numeric threshold.
  - `formatOffDiscordCount(n)` → `'1 time'` or `'N times'` (`0 times` for 0/null).
  - `evaluateVoteOutcome({ yes, no, playtimeHours, isTestSteamId, minYesVotes, minYesRate, voteAcceptHours })` → `{ outcome: 'accepted'|'denied', votesOk, hoursOk, hoursUnverified, denyReason: string|null }`.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'bun:test';
import {
  shouldSkipVoteStart,
  shouldShowHoursWarning,
  hoursWarningValue,
  formatOffDiscordCount,
  evaluateVoteOutcome,
} from '../prospectVoteRules.js';

describe('shouldSkipVoteStart', () => {
  it('skips only when hours are a number below the start gate', () => {
    expect(shouldSkipVoteStart(5.9, 6)).toBe(true);
    expect(shouldSkipVoteStart(6, 6)).toBe(false);
    expect(shouldSkipVoteStart(16, 6)).toBe(false);
    expect(shouldSkipVoteStart(null, 6)).toBe(false);
    expect(shouldSkipVoteStart(undefined, 6)).toBe(false);
  });
});

describe('shouldShowHoursWarning', () => {
  it('shows the warning only when hours are known and below accept', () => {
    expect(shouldShowHoursWarning(8.4, 16)).toBe(true);
    expect(shouldShowHoursWarning(16, 16)).toBe(false);
    expect(shouldShowHoursWarning(null, 16)).toBe(false);
  });
});

describe('copy helpers', () => {
  it('embeds the accept threshold in the warning', () => {
    expect(hoursWarningValue(16)).toContain('16 hours');
    expect(hoursWarningValue(16)).toContain('cannot be accepted');
  });
  it('pluralises the off-discord count', () => {
    expect(formatOffDiscordCount(0)).toBe('0 times');
    expect(formatOffDiscordCount(1)).toBe('1 time');
    expect(formatOffDiscordCount(3)).toBe('3 times');
    expect(formatOffDiscordCount(null)).toBe('0 times');
  });
});

const passingVotes = { yes: 10, no: 2, minYesVotes: 10, minYesRate: 0.8, voteAcceptHours: 16 };

describe('evaluateVoteOutcome', () => {
  it('accepts when votes and hours both pass', () => {
    const r = evaluateVoteOutcome({ ...passingVotes, playtimeHours: 16, isTestSteamId: false });
    expect(r.outcome).toBe('accepted');
    expect(r.denyReason).toBeNull();
  });
  it('denies on hours when votes pass', () => {
    const r = evaluateVoteOutcome({ ...passingVotes, playtimeHours: 8.4, isTestSteamId: false });
    expect(r.outcome).toBe('denied');
    expect(r.votesOk).toBe(true);
    expect(r.hoursOk).toBe(false);
    expect(r.denyReason).toBe('The 16-hour in-game requirement was not met.');
  });
  it('denies on votes when hours pass', () => {
    const r = evaluateVoteOutcome({ ...passingVotes, yes: 4, no: 2, playtimeHours: 20, isTestSteamId: false });
    expect(r.outcome).toBe('denied');
    expect(r.denyReason).toBe('The membership vote did not pass.');
  });
  it('uses the combined reason when both fail', () => {
    const r = evaluateVoteOutcome({ ...passingVotes, yes: 4, no: 2, playtimeHours: 5, isTestSteamId: false });
    expect(r.denyReason).toBe(
      'The membership vote did not pass, and the 16-hour in-game requirement was not met.',
    );
  });
  it('skips the hours rule when playtime is missing', () => {
    const r = evaluateVoteOutcome({ ...passingVotes, playtimeHours: null, isTestSteamId: false });
    expect(r.hoursOk).toBe(true);
    expect(r.hoursUnverified).toBe(true);
    expect(r.outcome).toBe('accepted');
  });
  it('skips the hours rule for test steam ids', () => {
    const r = evaluateVoteOutcome({ ...passingVotes, playtimeHours: 1, isTestSteamId: true });
    expect(r.hoursOk).toBe(true);
    expect(r.hoursUnverified).toBe(false);
    expect(r.outcome).toBe('accepted');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/prospect/__tests__/prospectVoteRules.test.js`

Expected: FAIL — `Cannot find module '../prospectVoteRules.js'`

- [ ] **Step 3: Write minimal implementation**

```js
export function shouldSkipVoteStart(playtimeHours, voteStartHours) {
  return typeof playtimeHours === 'number' && playtimeHours < voteStartHours;
}

export function shouldShowHoursWarning(playtimeHours, voteAcceptHours) {
  return typeof playtimeHours === 'number' && playtimeHours < voteAcceptHours;
}

export function hoursWarningValue(voteAcceptHours) {
  return (
    `This prospect has not completed the required ${voteAcceptHours} hours in-game. ` +
    `The vote will still run, but they cannot be accepted until they reach ${voteAcceptHours} hours.`
  );
}

export function formatOffDiscordCount(n) {
  const count = Number(n) || 0;
  return `${count} ${count === 1 ? 'time' : 'times'}`;
}

export function evaluateVoteOutcome({
  yes,
  no,
  playtimeHours,
  isTestSteamId,
  minYesVotes = 10,
  minYesRate = 0.8,
  voteAcceptHours = 16,
}) {
  const totalVotes = yes + no;
  const yesRate = totalVotes > 0 ? yes / totalVotes : 0;
  const votesOk = yes >= minYesVotes && yesRate >= minYesRate;
  const playtimeMissing = playtimeHours == null;
  const hoursUnverified = !isTestSteamId && playtimeMissing;
  const hoursOk = Boolean(isTestSteamId) || playtimeMissing || playtimeHours >= voteAcceptHours;
  const outcome = votesOk && hoursOk ? 'accepted' : 'denied';

  let denyReason = null;
  if (outcome === 'denied') {
    if (!votesOk && !hoursOk) {
      denyReason = 'The membership vote did not pass, and the 16-hour in-game requirement was not met.';
    } else if (!hoursOk) {
      denyReason = 'The 16-hour in-game requirement was not met.';
    } else {
      denyReason = 'The membership vote did not pass.';
    }
  }

  return { outcome, votesOk, hoursOk, hoursUnverified, denyReason };
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `bun test src/services/prospect/__tests__/prospectVoteRules.test.js`

Expected: PASS (all cases)

- [ ] **Step 5: Commit**

```bash
git add src/services/prospect/prospectVoteRules.js src/services/prospect/__tests__/prospectVoteRules.test.js
git commit -m "feat(prospect): add vote hour and deny-reason rules"
```

---

### Task 2: Vote embed warning + Off Discord line

**Files:**
- Modify: `src/services/prospect/prospectEmbeds.js` (`buildVoteEmbed`)
- Modify: `src/services/prospect/__tests__/prospectVoteEmbed.test.js`

**Interfaces:**
- Consumes: `shouldShowHoursWarning`, `hoursWarningValue`, `formatOffDiscordCount` from `prospectVoteRules.js`; `config.prospects.voteAcceptHours`.
- Produces: `buildVoteEmbed(prospect, stats)` reads `stats.playtime.playtimeHours` and `stats.offDiscordCount` (default 0). Adds field `Hours requirement` when hours are under accept. Discord field always ends with `Off Discord: **N time(s)**`.

- [ ] **Step 1: Write the failing tests** (append to `prospectVoteEmbed.test.js`)

```js
  it('adds Hours requirement when gameplay hours are under 16', () => {
    const e = buildVoteEmbed(baseProspect, {
      playtime: { playtimeHours: 8.4, seedHours: 1 },
      combat: { kills: 1, deaths: 1, teamkills: 0, daysActive: 4 },
    }).toJSON();
    const warning = e.fields.find((f) => f.name === 'Hours requirement');
    expect(warning).toBeTruthy();
    expect(warning.value).toContain('16 hours');
    expect(warning.inline).not.toBe(true);
  });

  it('omits Hours requirement when gameplay hours are 16+', () => {
    const e = buildVoteEmbed(baseProspect, {
      playtime: { playtimeHours: 16, seedHours: 1 },
      combat: { kills: 1, deaths: 1, teamkills: 0, daysActive: 4 },
    }).toJSON();
    expect(e.fields.find((f) => f.name === 'Hours requirement')).toBeFalsy();
  });

  it('omits Hours requirement when playtime is missing', () => {
    const e = buildVoteEmbed(baseProspect, null).toJSON();
    expect(e.fields.find((f) => f.name === 'Hours requirement')).toBeFalsy();
  });

  it('always shows Off Discord including zero', () => {
    const zero = buildVoteEmbed(baseProspect, null).toJSON();
    expect(zero.fields.find((f) => f.name === 'Discord').value).toContain('Off Discord: **0 times**');
    const three = buildVoteEmbed(baseProspect, { offDiscordCount: 3 }).toJSON();
    expect(three.fields.find((f) => f.name === 'Discord').value).toContain('Off Discord: **3 times**');
    const one = buildVoteEmbed(baseProspect, { offDiscordCount: 1 }).toJSON();
    expect(one.fields.find((f) => f.name === 'Discord').value).toContain('Off Discord: **1 time**');
  });
```

Keep the existing three tests; they still must pass. The first existing test will fail until the Discord field also contains the new line (it only asserts Hours/Messages, so it should still pass).

- [ ] **Step 2: Run test to verify new cases fail**

Run: `bun test src/services/prospect/__tests__/prospectVoteEmbed.test.js`

Expected: FAIL on Hours requirement / Off Discord assertions.

- [ ] **Step 3: Update `buildVoteEmbed`**

Add imports at the top of `prospectEmbeds.js`:

```js
import {
  shouldShowHoursWarning,
  hoursWarningValue,
  formatOffDiscordCount,
} from './prospectVoteRules.js';
```

`config` is already imported.

After the description / voting-ends / extra-days fields, before combat:

```js
  const acceptHours = config.prospects?.voteAcceptHours ?? 16;
  if (shouldShowHoursWarning(stats?.playtime?.playtimeHours, acceptHours)) {
    embed.addFields({
      name: 'Hours requirement',
      value: hoursWarningValue(acceptHours),
    });
  }
```

Replace the Discord field value with:

```js
    const offDiscord = formatOffDiscordCount(stats?.offDiscordCount);
    embed.addFields({
      name: 'Discord',
      value: `Hours: **${voiceHours}**\nMessages: **${messageCount}**\nOff Discord: **${offDiscord}**`,
      inline: true,
    });
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `bun test src/services/prospect/__tests__/prospectVoteEmbed.test.js`

Expected: PASS (existing + new)

- [ ] **Step 5: Commit**

```bash
git add src/services/prospect/prospectEmbeds.js src/services/prospect/__tests__/prospectVoteEmbed.test.js
git commit -m "feat(prospect): show hours warning and off-discord count on vote embed"
```

---

### Task 3: Alert title matcher + schema + persist helpers

**Files:**
- Modify: `src/services/commsWatch/commsWatchEmbeds.js`
- Modify: `src/services/commsWatch/__tests__/commsWatchEmbeds.test.js`
- Modify: `src/database/schema.js` (after the `prospect_forum_messages` block, before prospect ALTER migrations)
- Modify: `src/services/commsWatch/commsWatchService.js`

**Interfaces:**
- Consumes: `query()` from `../../database/connection.js`.
- Produces:
  - `COMMS_ALERT_TITLE = 'Prospect not on Discord while in-game'`
  - `LEGACY_COMMS_ALERT_TITLE = 'Prospect off comms while in-game'`
  - `isCommsAlertTitle(title)` → boolean
  - `insertCommsAlert(prospectId, discordMessageId, createdAt = null)` → Promise<void> (`INSERT IGNORE`)
  - `getCommsAlertCount(prospectId)` → Promise<number>
  - `buildProspectAlertEmbed` uses `COMMS_ALERT_TITLE` (no copy change)

- [ ] **Step 1: Write failing title-matcher tests** (append to `commsWatchEmbeds.test.js`)

```js
import { buildBoardEmbed, buildProspectAlertEmbed, isCommsAlertTitle, COMMS_ALERT_TITLE, LEGACY_COMMS_ALERT_TITLE } from '../commsWatchEmbeds.js';

describe('isCommsAlertTitle', () => {
  test('matches current and legacy titles only', () => {
    expect(isCommsAlertTitle(COMMS_ALERT_TITLE)).toBe(true);
    expect(isCommsAlertTitle(LEGACY_COMMS_ALERT_TITLE)).toBe(true);
    expect(isCommsAlertTitle('Vote Started')).toBe(false);
    expect(isCommsAlertTitle(undefined)).toBe(false);
  });
});
```

Update the existing title assertion to use `COMMS_ALERT_TITLE` so the string lives in one place.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/commsWatch/__tests__/commsWatchEmbeds.test.js`

Expected: FAIL — `isCommsAlertTitle` is not exported.

- [ ] **Step 3: Implement titles, schema, and helpers**

In `commsWatchEmbeds.js`:

```js
export const COMMS_ALERT_TITLE = 'Prospect not on Discord while in-game';
export const LEGACY_COMMS_ALERT_TITLE = 'Prospect off comms while in-game';

export function isCommsAlertTitle(title) {
  return title === COMMS_ALERT_TITLE || title === LEGACY_COMMS_ALERT_TITLE;
}
```

Change `.setTitle('Prospect not on Discord while in-game')` to `.setTitle(COMMS_ALERT_TITLE)`.

In `schema.js`, after the `prospect_forum_messages` `CREATE TABLE` (before `// Prospect table migrations`):

```js
  await query(`
    CREATE TABLE IF NOT EXISTS prospect_comms_alerts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      prospect_id INT NOT NULL,
      discord_message_id VARCHAR(20) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_message (discord_message_id),
      INDEX idx_pca_prospect (prospect_id),
      FOREIGN KEY (prospect_id) REFERENCES prospects(id)
    )
  `);
```

Append to `commsWatchService.js`:

```js
export async function insertCommsAlert(prospectId, discordMessageId, createdAt = null) {
  if (createdAt) {
    await query(
      `INSERT IGNORE INTO prospect_comms_alerts (prospect_id, discord_message_id, created_at) VALUES (?, ?, ?)`,
      [prospectId, String(discordMessageId), createdAt],
    );
    return;
  }
  await query(
    `INSERT IGNORE INTO prospect_comms_alerts (prospect_id, discord_message_id) VALUES (?, ?)`,
    [prospectId, String(discordMessageId)],
  );
}

export async function getCommsAlertCount(prospectId) {
  try {
    const rows = await query(
      'SELECT COUNT(*) AS n FROM prospect_comms_alerts WHERE prospect_id = ?',
      [prospectId],
    );
    return Number(rows[0]?.n || 0);
  } catch (err) {
    log.warn({ err, prospectId }, 'Failed to count comms alerts');
    return 0;
  }
}
```

Do not unit-test the SQL helpers against a live DB. Title matching is the testable contract.

- [ ] **Step 4: Run embed tests**

Run: `bun test src/services/commsWatch/__tests__/commsWatchEmbeds.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/commsWatch/commsWatchEmbeds.js src/services/commsWatch/__tests__/commsWatchEmbeds.test.js src/database/schema.js src/services/commsWatch/commsWatchService.js
git commit -m "feat(comms-watch): persist prospect off-discord alerts"
```

---

### Task 4: Config, scheduler 6h gate, Force Vote copy

**Files:**
- Modify: `settings.development.js` — inside `prospects`, after `voteDaysBefore: 14,` add `voteStartHours: 6,` and `voteAcceptHours: 16,`
- Modify: `settings.staging.js` — same two keys in the same place
- Modify: `settings.production.js` — same two keys in the same place
- Modify: `src/services/prospect/prospectScheduler.js`
- Modify: `src/handlers/prospectButtons.js` (`handleTestVote`)

**Interfaces:**
- Consumes: `shouldSkipVoteStart` from `prospectVoteRules.js`; `config.prospects.voteStartHours` / `voteAcceptHours`.
- Produces: scheduler posts when hours `>= voteStartHours` or playtime is `null`. Staff insufficient-playtime embed uses `voteStartHours`. Force Vote warns against `voteAcceptHours`, still posts.

- [ ] **Step 1: Add the two keys to all three settings files**

```js
    voteStartHours: 6,
    voteAcceptHours: 16,
```

immediately after `voteDaysBefore: 14,`. `settings.test.js` re-exports development — no edit.

- [ ] **Step 2: Wire the scheduler**

Import `shouldSkipVoteStart` from `./prospectVoteRules.js`.

Replace the `if (stats && stats.playtimeHours < 16)` block with:

```js
          const startHours = config.prospects?.voteStartHours ?? 6;
          if (shouldSkipVoteStart(stats?.playtimeHours ?? null, startHours)) {
            log.info({ prospectId: prospect.id, playtimeHours: stats.playtimeHours }, 'Skipping vote - below start hours');

            const { periodEnd } = getProspectDates(prospect);

            if (new Date() >= periodEnd && !lowPlaytimeWarned.has(prospect.id)) {
              lowPlaytimeWarned.add(prospect.id);
              const guild = await client.guilds.fetch(config.guild.id).catch(() => null);
              const staffChannel = guild ? await guild.channels.fetch(prospect.channel_id).catch(() => null) : null;
              if (staffChannel) {
                const warnEmbed = createEmbed('Prospect')
                  .setTitle('Insufficient Playtime')
                  .setDescription(
                    `**${prospect.alias}**'s prospect period has ended but they only have **${stats.playtimeHours}h** of playtime (${startHours}h required to start the vote).\n` +
                    `The vote will be posted automatically once they reach ${startHours} hours, or a staff member can force-vote from the ticket.`
                  )
                  .setColor(0xed4245);
                await staffChannel.send({ embeds: [warnEmbed] }).catch(() => null);
              }
            }
            continue;
          } else {
            lowPlaytimeWarned.delete(prospect.id);
          }
```

Keep the `if (!isTestSteamId(prospect.steam_id)) { const stats = await getPlaytime(...)` wrapper as it is today. When `stats` is null, `shouldSkipVoteStart(null, 6)` is false → vote posts.

- [ ] **Step 3: Update Force Vote copy**

In `handleTestVote`, replace the `< 16` block:

```js
    const acceptHours = config.prospects?.voteAcceptHours ?? 16;
    if (stats && stats.playtimeHours < acceptHours) {
      playtimeWarning = `**${prospect.alias}** only has **${stats.playtimeHours}h** playtime (${acceptHours}h required to be accepted). Posting vote anyway since this is a force action.`;
    }
```

`config` is already imported in this file (`import config from '../config.js';`).

- [ ] **Step 4: Run related unit tests**

Run: `bun test src/services/prospect/__tests__/prospectVoteRules.test.js src/services/prospect/__tests__/prospectVoteEmbed.test.js`

Expected: PASS. Scheduler has no unit file; rules tests cover the predicate.

- [ ] **Step 5: Commit**

```bash
git add settings.development.js settings.staging.js settings.production.js src/services/prospect/prospectScheduler.js src/handlers/prospectButtons.js
git commit -m "feat(prospect): start votes at 6h gameplay"
```

---

### Task 5: `finalizeVote` hours check + vote-embed stats/refresh

**Files:**
- Modify: `src/services/prospect/prospectVoting.js`

**Interfaces:**
- Consumes: `evaluateVoteOutcome` from `prospectVoteRules.js`; `getPlaytime`; `getCommsAlertCount`; `isTestSteamId`; `config.prospects.minYesVotes` / `minYesRate` / `voteAcceptHours`.
- Produces:
  - `loadVoteStats(prospect)` → `{ playtime, combat, voice, messages, offDiscordCount }`
  - `refreshVoteEmbed(prospect, client)` → edits the existing vote message embeds only
  - `postVote` uses `loadVoteStats` instead of inlined fetches
  - `finalizeVote` uses `evaluateVoteOutcome`; posts unverified-hours info; deny reason and staff warning include hours

- [ ] **Step 1: Add `loadVoteStats` and switch `postVote` to it**

At the top of `prospectVoting.js` add imports:

```js
import { evaluateVoteOutcome } from './prospectVoteRules.js';
import { getCommsAlertCount } from '../commsWatch/commsWatchService.js';
```

Replace the inlined stats block in `postVote` (from `periodStartIso` through `buildVoteEmbed(...)`) with:

```js
export async function loadVoteStats(prospect) {
  const periodStartIso = new Date(prospect.period_started_at || prospect.created_at).toISOString().slice(0, 10);
  const nowIso = new Date().toISOString().slice(0, 10);

  let playtime = null;
  let combat = null;
  if (!isTestSteamId(prospect.steam_id)) {
    [playtime, combat] = await Promise.all([
      getPlaytime(prospect.steam_id, periodStartIso, nowIso).catch(() => null),
      getProspectStats(prospect.steam_id, periodStartIso, nowIso).catch(() => null),
    ]);
  }

  const [voice, messages, offDiscordCount] = await Promise.all([
    getVoiceStats(prospect.user_id, periodStartIso, nowIso).catch(() => null),
    getMessageStats(prospect.user_id, periodStartIso, nowIso).catch(() => null),
    getCommsAlertCount(prospect.id).catch(() => 0),
  ]);

  return { playtime, combat, voice, messages, offDiscordCount };
}

export async function refreshVoteEmbed(prospect, client) {
  if (!prospect?.forum_thread_id || !prospect?.vote_message_id) return;
  const guild = await client.guilds.fetch(config.guild.id).catch(() => null);
  if (!guild) return;
  const { forumChannelId } = config.prospects;
  const forumChannel = forumChannelId ? await guild.channels.fetch(forumChannelId).catch(() => null) : null;
  if (!forumChannel) return;
  const thread = await forumChannel.threads.fetch(prospect.forum_thread_id).catch(() => null);
  if (!thread) return;
  const voteMsg = await thread.messages.fetch(prospect.vote_message_id).catch(() => null);
  if (!voteMsg) {
    log.warn({ prospectId: prospect.id }, 'refreshVoteEmbed: vote message missing');
    return;
  }
  const stats = await loadVoteStats(prospect);
  const voteEmbed = buildVoteEmbed(prospect, stats);
  await voteMsg.edit({ embeds: [voteEmbed] });
}
```

In `postVote`, after the thread/tag setup:

```js
  const stats = await loadVoteStats(prospect);
  const voteEmbed = buildVoteEmbed(prospect, stats);
```

- [ ] **Step 2: Replace the outcome block in `finalizeVote`**

Replace from `const MIN_VOTES = ...` through `const reason = ...` with:

```js
  const MIN_VOTES = config.prospects?.minYesVotes ?? 10;
  const MIN_RATE = config.prospects?.minYesRate ?? 0.80;
  const acceptHours = config.prospects?.voteAcceptHours ?? 16;

  let playtimeHours = null;
  if (!isTestSteamId(prospect.steam_id)) {
    const periodStartIso = new Date(prospect.period_started_at || prospect.created_at).toISOString().slice(0, 10);
    const nowIso = new Date().toISOString().slice(0, 10);
    const stats = await getPlaytime(prospect.steam_id, periodStartIso, nowIso).catch(() => null);
    playtimeHours = stats ? stats.playtimeHours : null;
  }

  const judged = evaluateVoteOutcome({
    yes: counts.yes,
    no: counts.no,
    playtimeHours,
    isTestSteamId: isTestSteamId(prospect.steam_id),
    minYesVotes: MIN_VOTES,
    minYesRate: MIN_RATE,
    voteAcceptHours: acceptHours,
  });
  const outcome = judged.outcome;

  const staffChannel = await guild.channels.fetch(prospect.channel_id).catch(() => null);

  if (judged.hoursUnverified && staffChannel) {
    await staffChannel.send({
      embeds: [infoEmbed('Could not verify gameplay hours; the 16-hour accept rule was skipped.')],
    }).catch(() => null);
  }

  if (outcome === 'denied' && staffChannel) {
    const warnings = [];
    if (!judged.votesOk) {
      const totalVotes = counts.yes + counts.no;
      const yesRate = totalVotes > 0 ? counts.yes / totalVotes : 0;
      if (counts.yes < MIN_VOTES) warnings.push(`${counts.yes}/${MIN_VOTES} minimum yes votes`);
      if (yesRate < MIN_RATE) warnings.push(`${Math.round(yesRate * 100)}% of ${Math.round(MIN_RATE * 100)}% required yes rate`);
    }
    if (!judged.hoursOk) warnings.push(`${playtimeHours}/${acceptHours} required gameplay hours`);
    if (warnings.length > 0) {
      await staffChannel.send({
        embeds: [infoEmbed(`Thresholds not met: ${warnings.join(', ')}. Prospect will be **denied**.`)],
      }).catch(() => null);
    }
  }

  const reason = outcome === 'denied' ? judged.denyReason : undefined;
  await closeProspect(prospect, actorId, outcome, guild, reason);
```

Delete the old `const staffChannel = ...` that followed the previous outcome line so it is not declared twice. The rest of `finalizeVote` (disable End Vote button, success embed) stays.

- [ ] **Step 3: Run unit tests**

Run: `bun test src/services/prospect/__tests__ src/services/commsWatch/__tests__`

Expected: PASS. `finalizeVote` itself stays integration-heavy; `evaluateVoteOutcome` is the tested contract.

- [ ] **Step 4: Commit**

```bash
git add src/services/prospect/prospectVoting.js
git commit -m "feat(prospect): deny votes that lack 16h gameplay"
```

---

### Task 6: Live alert insert, embed refresh, startup backfill

**Files:**
- Modify: `src/services/commsWatch/commsWatchMonitor.js`
- Modify: `src/services/commsWatch/commsWatchService.js` (add `backfillProspectCommsAlerts`)
- Modify: `src/services/commsWatch/commsWatchService.js` `getOpenProspects` SELECT list — add `vote_message_id, forum_thread_id, period_started_at, extra_days, created_at`

**Interfaces:**
- Consumes: `insertCommsAlert`, `isCommsAlertTitle`, `refreshVoteEmbed`, `getOpenProspects`.
- Produces:
  - Tracked prospect objects include `prospectId`
  - `postProspectAlert` inserts after send, then refreshes the vote embed
  - `backfillProspectCommsAlerts(client)` scans open ticket channels; `INSERT IGNORE`; refreshes vote embeds once per prospect that has a vote message
  - `startScheduler` kicks backfill without awaiting it on the tick path

- [ ] **Step 1: Thread `prospectId` through classify + alert**

In `classifyRoster`, when pushing a prospect:

```js
        prospectId: prospect.id,
        voteMessageId: prospect.vote_message_id,
        forumThreadId: prospect.forum_thread_id,
        periodStartedAt: prospect.period_started_at,
        extraDays: prospect.extra_days,
        createdAt: prospect.created_at,
```

`getOpenProspects` SELECT becomes:

```sql
SELECT id, user_id, steam_id, alias, mentor_id, channel_id,
       vote_message_id, forum_thread_id, period_started_at, extra_days, created_at
FROM prospects
WHERE status = 'open'
  AND channel_id IS NOT NULL
  AND period_started_at IS NOT NULL
```

- [ ] **Step 2: Persist on send**

Replace the end of `postProspectAlert` (from `await channel.send` onward) with:

```js
  const sent = await channel.send({ content, embeds: [embed], allowedMentions });
  log.info({ discordId: a.discordId, offCommsMs: a.offCommsMs }, 'Posted prospect comms alert');

  if (a.prospectId && sent?.id) {
    try {
      await insertCommsAlert(a.prospectId, sent.id);
    } catch (err) {
      log.warn({ err, prospectId: a.prospectId, messageId: sent.id }, 'Failed to persist comms alert');
    }
    if (a.voteMessageId && a.forumThreadId) {
      const prospect = {
        id: a.prospectId,
        user_id: a.discordId,
        steam_id: a.steamId,
        alias: a.alias,
        mentor_id: a.prospectMentorId,
        forum_thread_id: a.forumThreadId,
        vote_message_id: a.voteMessageId,
        period_started_at: a.periodStartedAt,
        extra_days: a.extraDays,
        created_at: a.createdAt,
      };
      await refreshVoteEmbed(prospect, client).catch((err) =>
        log.warn({ err, prospectId: a.prospectId }, 'Failed to refresh vote embed after comms alert'),
      );
    }
  }
```

Import `insertCommsAlert` from `./commsWatchService.js` and `refreshVoteEmbed` from `../prospect/prospectVoting.js`.

- [ ] **Step 3: Implement backfill**

Add to `commsWatchService.js`:

```js
import { isCommsAlertTitle } from './commsWatchEmbeds.js';

let backfillRunning = false;

export async function backfillProspectCommsAlerts(client) {
  if (backfillRunning) return;
  backfillRunning = true;
  try {
    const prospects = await getOpenProspects();
    for (const prospect of prospects) {
      const channel = await client.channels.fetch(prospect.channel_id).catch(() => null);
      if (!channel?.messages) continue;
      let before;
      const found = [];
      while (true) {
        const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
        if (!batch || batch.size === 0) break;
        for (const message of batch.values()) {
          if (!message.author?.bot) continue;
          const title = message.embeds?.[0]?.title;
          if (!isCommsAlertTitle(title)) continue;
          found.push(message);
        }
        before = batch.last()?.id;
        if (batch.size < 100) break;
      }
      for (const message of found) {
        await insertCommsAlert(prospect.id, message.id, message.createdAt).catch((err) =>
          log.warn({ err, prospectId: prospect.id, messageId: message.id }, 'backfill insert failed'),
        );
      }
    }
  } catch (err) {
    log.warn({ err }, 'comms alert backfill failed');
  } finally {
    backfillRunning = false;
  }
}
```

After the loop, vote-embed refresh belongs in the monitor start path so `commsWatchService` does not import `prospectVoting` (avoid a cycle: voting → commsWatchService → voting). In `startScheduler`:

```js
export function startScheduler(client) {
  const c = cfg();
  if (!c.enabled) { log.info('Comms watch disabled; scheduler not started'); return; }
  log.info({ serverId: c.serverId, serverLabel: c.serverLabel, tickMs: c.tickMs, thresholdMs: c.thresholdMs }, 'Starting comms watch scheduler');
  scheduler.start(client);
  import('./commsWatchService.js').then(({ backfillProspectCommsAlerts }) =>
    backfillProspectCommsAlerts(client).then(async () => {
      const { refreshVoteEmbed } = await import('../prospect/prospectVoting.js');
      const prospects = await getOpenProspects();
      for (const p of prospects) {
        if (!p.vote_message_id || !p.forum_thread_id) continue;
        await refreshVoteEmbed({
          id: p.id,
          user_id: p.user_id,
          steam_id: p.steam_id,
          alias: p.alias,
          mentor_id: p.mentor_id,
          forum_thread_id: p.forum_thread_id,
          vote_message_id: p.vote_message_id,
          period_started_at: p.period_started_at,
          extra_days: p.extra_days,
          created_at: p.created_at,
        }, client).catch((err) => log.warn({ err, prospectId: p.id }, 'post-backfill vote embed refresh failed'));
      }
    }).catch((err) => log.warn({ err }, 'comms alert backfill failed')),
  );
}
```

Cleaner: keep backfill in the service, and after it resolves in `startScheduler` (already in monitor), refresh embeds there using a static import of `getOpenProspects` + dynamic import of `refreshVoteEmbed` only if needed.

Preferred wiring in `commsWatchMonitor.js` `startScheduler`:

```js
import { getOpenProspects, loadAllStates, upsertState, deleteStatesNotIn, getBoardPointer, clearBoardPointer, insertCommsAlert, backfillProspectCommsAlerts } from './commsWatchService.js';

export function startScheduler(client) {
  const c = cfg();
  if (!c.enabled) { log.info('Comms watch disabled; scheduler not started'); return; }
  log.info({ serverId: c.serverId, serverLabel: c.serverLabel, tickMs: c.tickMs, thresholdMs: c.thresholdMs }, 'Starting comms watch scheduler');
  scheduler.start(client);
  void (async () => {
    await backfillProspectCommsAlerts(client);
    const { refreshVoteEmbed } = await import('../prospect/prospectVoting.js');
    const prospects = await getOpenProspects();
    for (const p of prospects) {
      if (!p.vote_message_id || !p.forum_thread_id) continue;
      await refreshVoteEmbed({
        id: p.id,
        user_id: p.user_id,
        steam_id: p.steam_id,
        alias: p.alias,
        mentor_id: p.mentor_id,
        forum_thread_id: p.forum_thread_id,
        vote_message_id: p.vote_message_id,
        period_started_at: p.period_started_at,
        extra_days: p.extra_days,
        created_at: p.created_at,
      }, client).catch((err) => log.warn({ err, prospectId: p.id }, 'post-backfill vote embed refresh failed'));
    }
  })();
}
```

Do **not** `await` this from the first monitor tick.

- [ ] **Step 4: Run unit tests**

Run: `bun test src/services/commsWatch/__tests__ src/services/prospect/__tests__`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/commsWatch/commsWatchMonitor.js src/services/commsWatch/commsWatchService.js
git commit -m "feat(comms-watch): count alerts and refresh vote embeds"
```

---

### Task 7: Website count on staff detail + public page

**Files:**
- Modify: `RoyalBattalionWebpage/packages/shared/types/tickets.ts` — `Prospect`
- Modify: `RoyalBattalionWebpage/packages/api/src/routes/prospects.ts` — `GET /:id` and `GET /by-uuid/:uuid`
- Modify: `RoyalBattalionWebpage/packages/web/app/(protected)/tickets/page.tsx` — `ProspectDetail` + `exportProspectText`
- Modify: `RoyalBattalionWebpage/packages/web/app/(public)/prospect/[uuid]/page.tsx`

Work in `C:\Users\OleEd\Azure\RoyalBattalionWebpage` (separate git repo).

**Interfaces:**
- Consumes: secretary table `prospect_comms_alerts` (may be missing before bot deploy).
- Produces: `Prospect.offDiscordCount?: number`. Detail endpoints set it. List endpoint may omit it. UI shows `N times` via `prospect.offDiscordCount ?? 0`.

- [ ] **Step 1: Extend the shared type**

In `Prospect`, after `extraDays: number;`:

```ts
  offDiscordCount?: number;
```

Optional so `GET /` list mapping does not need a dummy 0.

- [ ] **Step 2: Add a count helper and call it from both detail routes**

In `prospects.ts`, next to the other helpers:

```ts
async function getOffDiscordCount(prospectId: number): Promise<number> {
  try {
    const rows: Array<{ n: bigint | number }> = await getSecretaryDb().$queryRaw(Prisma.sql`
      SELECT COUNT(*) AS n FROM prospect_comms_alerts WHERE prospect_id = ${prospectId}
    `);
    return Number(rows[0]?.n ?? 0);
  } catch (err) {
    logger.warn("discord-bot", "Failed to load off-discord count", err);
    return 0;
  }
}
```

In `GET /:id` and `GET /by-uuid/:uuid`, after the vote query (same place as other extras):

```ts
    const offDiscordCount = await getOffDiscordCount(id);
```

Add `offDiscordCount,` to both `prospect` object literals.

- [ ] **Step 3: Staff + public UI + export**

In `ProspectDetail` info grid, after Steam ID (before Mentor):

```tsx
        <div>
          <span className="text-xs font-medium tracking-[0.1em] text-text-muted uppercase">Off Discord</span>
          <div className="text-sm text-text-primary">
            {prospect.offDiscordCount ?? 0} {(prospect.offDiscordCount ?? 0) === 1 ? "time" : "times"}
          </div>
        </div>
```

In `exportProspectText`, after Steam ID:

```ts
  lines.push(`Off Discord: ${prospect.offDiscordCount ?? 0}`);
```

On the public page application-info grid, after Steam ID:

```tsx
                <div>
                  <span className="text-xs font-medium tracking-[0.1em] text-text-muted uppercase">Off Discord</span>
                  <div className="mt-0.5 text-sm text-text-primary">
                    {prospect.offDiscordCount ?? 0} {(prospect.offDiscordCount ?? 0) === 1 ? "time" : "times"}
                  </div>
                </div>
```

- [ ] **Step 4: Typecheck**

Run (from `RoyalBattalionWebpage`): `bunx tsc -p packages/shared --noEmit` and `bunx tsc -p packages/api --noEmit` if those projects support it. If `tsc` is not configured per package, run `bun run --filter api build` / the repo's existing typecheck. Expected: no new errors.

There is no existing prospect-page unit test. Do not add a snapshot farm.

- [ ] **Step 5: Commit in the website repo**

```bash
git add packages/shared/types/tickets.ts packages/api/src/routes/prospects.ts "packages/web/app/(protected)/tickets/page.tsx" "packages/web/app/(public)/prospect/[uuid]/page.tsx"
git commit -m "feat(prospects): show off-discord catch count"
```

---

### Task 8: Version bump + full bot test run

**Files:**
- Modify: `package.json` (`version`: `2.35.1` → `2.36.0`)

- [ ] **Step 1: Run the full bot suite**

Run (from `RoyalSecretaryDiscordBot`): `bun test`

Expected: PASS. If anything fails, fix it in this task before bumping.

- [ ] **Step 2: Bump version**

```json
  "version": "2.36.0",
```

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore(release): bump version to 2.36.0"
```

---

## Self-review (spec coverage)

| Spec requirement | Task |
|---|---|
| `voteStartHours` / `voteAcceptHours` in all env settings | 4 |
| Scheduler starts vote at 6h; staff warning copy uses 6h | 4 |
| Missing playtime does not block start | 1 + 4 |
| Hours-requirement field when `< 16` | 1 + 2 |
| Field omitted at 16+ or unknown hours | 1 + 2 |
| `finalizeVote` denies on hours; skip hours if playtime null; test steam skip | 1 + 5 |
| Deny reasons (votes / hours / both) | 1 + 5 |
| Staff unverified-hours notice | 5 |
| Force Vote still works; warn on accept bar | 4 |
| Interview Accepted / panel 16h copy unchanged | no task (out of scope) |
| `prospect_comms_alerts` + COUNT | 3 |
| Live insert after staff alert | 6 |
| Failed insert does not drop the alert | 6 |
| Off Discord line including 0 | 2 |
| Mid-vote embed refresh (embeds only) | 5 + 6 |
| Backfill both titles, open tickets only, INSERT IGNORE | 3 + 6 |
| Backfill does not block first tick | 6 |
| Website type + two detail routes + two UIs + export | 7 |
| List endpoint not required to query the table | 7 (`offDiscordCount?`) |
| Version 2.36.0 | 8 |
| No member-board / 15-min / incident-list / closed-ticket backfill | out of scope |
