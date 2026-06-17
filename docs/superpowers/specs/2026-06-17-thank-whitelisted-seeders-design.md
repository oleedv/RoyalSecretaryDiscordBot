# Thank whitelisted seeders — design

Date: 2026-06-17

## Summary

When a player completes a seed session, the seed tracker currently rewards or
encourages players who do **not** hold a whitelist (grant the Seeder reward, or
post a progression embed). Anyone who already holds a whitelist is silently
skipped.

This feature adds a public "thank you" for whitelist holders who help seed —
specifically everyone **except** Seeder-reward holders — posted to a new,
website-configurable channel, at most once per day per player.

## Current behavior (for reference)

`processCompletedSession` (`src/services/seedTracker/seedTrackerService.js`)
fires per player on a completed seed session. It loads the player's seed stats
and their active whitelist, then calls the pure `decideSeederAction`
(`src/services/seedTracker/seederRewardLogic.js`):

- Active **non-Seeder** whitelist (clan / admin / donor / etc.) -> `skip`
- Active **Seeder** whitelist -> `extend` if newly earned, else `skip`
- **No** whitelist -> `grant` if earned, else `progression` (per-player embed
  posted to `progression_channel_id`)

Whitelist data comes from `getSeederWhitelist`, which returns the active
(non-expired) `WhitelistEntry` row `{ id, role, expiresAt }` from the website DB
(`server = 'main'`).

## Goals

- Thank players who help seed and hold an **active whitelist that is not the
  Seeder reward** (clan, admin, donor, etc.).
- Post the thank-you to a **new, dedicated channel** configurable from the
  website (the "Seeder Appreciation Channel").
- Thank a given player **at most once per calendar day** (community timezone).
- Leave all existing paths (grant, extend, progression, no-whitelist skip)
  unchanged.

## Non-goals

- Thanking Seeder-reward holders (they already get progression embeds and silent
  renewals in the reward loop).
- Thanking players with no whitelist (unchanged: grant / progression).
- Including any seeding statistics in the thank-you message.
- Aggregated/batched "thanks to these seeders" digests — this is per-player.

## Design

### 1. Decision logic (bot)

In `seederRewardLogic.js`, the active non-Seeder whitelist branch returns a new
action instead of skipping:

```js
// before
if (whitelist && whitelist.role !== 'Seeder') return { action: 'skip' };
// after
if (whitelist && whitelist.role !== 'Seeder') return { action: 'thank' };
```

`decideSeederAction` stays pure — it does no I/O and does not know about the
once-per-day rule or the channel. Seeder-reward and no-whitelist branches are
untouched.

### 2. Service handling (bot)

In `processCompletedSession`, add a branch before the progression block:

```js
if (decision.action === 'thank') {
  await thankWhitelistedSeeder(data, cfg, client);
  return;
}
```

`thankWhitelistedSeeder(data, cfg, client)`:

1. If `cfg.appreciation_channel_id` is not set -> return (no-op, no record).
2. Compute `today` = calendar date string (`YYYY-MM-DD`) in `cfg.timezone` (the
   same timezone field the daily-call scheduler uses; add a small date-in-tz
   helper if one isn't already available).
3. Read `last_thanked_date` for `data.steamID` from `seed_thanks`.
4. If `shouldThankToday(lastThankedDate, today)` is false -> return.
5. Fetch the avatar, build the embed, send to the appreciation channel.
6. On a successful send, upsert `seed_thanks` with `last_thanked_date = today`
   and the current `player_name`.

Recording only after a successful send means a transient send failure simply
retries on the player's next completed session that day.

### 3. Once-per-day dedup (bot)

New table in `Royal_secretary`, created idempotently in `src/database/schema.js`
alongside the existing `ALTER TABLE seeding_config ...` statements:

```sql
CREATE TABLE IF NOT EXISTS seed_thanks (
  steam_id VARCHAR(20) NOT NULL PRIMARY KEY,
  player_name VARCHAR(255) NULL,
  last_thanked_date DATE NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

State lives in the DB (not an in-memory cache) so it survives bot restarts.

Pure helper (new, unit-tested) — colocated with the seed-tracker logic:

```js
// shouldThankToday(lastThankedDate, today) -> boolean
//   null/empty lastThankedDate            -> true
//   lastThankedDate !== today (string ==) -> true
//   lastThankedDate === today             -> false
```

Both arguments are `YYYY-MM-DD` strings computed in `cfg.timezone`, so the
comparison is a plain string equality and has no UTC-offset edge cases.

### 4. New channel config

**Bot:**
- `src/database/schema.js`: `ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS
  appreciation_channel_id VARCHAR(20) NULL`.
- Confirm `getSeedingConfig` returns the new column (extend the SELECT if it
  lists columns explicitly rather than `SELECT *`).
- Bot reads `cfg.appreciation_channel_id`.

**Website (branch off `origin/production`, not the local `rcon-only` branch —
the seed-tracker config currently lives on `origin/production` in
`packages/api/src/routes/discord-bot/seeding.ts`):**
- `GET /seeding/config`: add `appreciation_channel_id` to the SELECT and map to
  `appreciationChannelId`.
- `PUT /seeding/config`: persist `appreciation_channel_id` from the body.
- Shared `SeedingConfig` type (`packages/shared`): add
  `appreciationChannelId: string | null` next to `progressionChannelId` /
  `leaderboardChannelId`.
- `SeedingAdmin` UI: add a channel-ID input labeled **"Seeder Appreciation
  Channel"** beside the existing Progression / Leaderboard channel fields.

### 5. Thank-you embed

New `buildSeederThanksEmbed({ name, avatarUrl })` in
`src/services/seedTracker/seedTrackerEmbeds.js`:

- Color: `COLOR_SUCCESS` (green, already defined).
- Title: `Thanks for seeding!`
- Description: `**{name}** helped seed the server today. Thanks for getting the
  round started!`
- Thumbnail: player avatar when available.
- No emojis (per project style), no statistics.

### 6. Edge cases

- **Appreciation channel unset:** no-op, no DB record written.
- **Channel fetch/send fails:** logged best-effort; no record written so it can
  retry on the next session that day.
- **Player loses/gains whitelist:** decision is re-evaluated each session from
  live whitelist data, so behavior follows their current whitelist.
- **Expired whitelist:** `getSeederWhitelist` already filters to active rows, so
  expired holders fall through to the normal no-whitelist paths.

## Testing

- `decideSeederAction`: update existing test(s) so an active non-Seeder
  whitelist now expects `thank` (was `skip`); keep Seeder extend/skip and
  no-whitelist grant/progression cases.
- `shouldThankToday`: null -> true, earlier date -> true, same date -> false.
- `buildSeederThanksEmbed`: title, description contains the name, thumbnail set
  when an avatar is given, no stats fields.

## Versioning & deploy

- Bot: minor version bump (new feature), deploy via the standard
  `main` -> staging, merge `main` -> `production` flow.
- Webpage: bump root `package.json` + changed `packages/*`; build off
  `origin/production` and deploy via that branch (Railway).
- The bot's `schema.js` runs the `ALTER TABLE` / `CREATE TABLE` idempotently on
  boot, so no manual migration step is required.

## Open questions

None.
