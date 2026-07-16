# Seed Progress / Milestone posts once per day per player

Date: 2026-07-16
Status: Approved

## Problem

`processCompletedSession` (in `src/services/seedTracker/seedTrackerService.js`) posts the
**Seed Progress** embed (`buildProgressionEmbed`) on every `SEED_SESSION_COMPLETE` event, and
`processMilestone` posts the milestone embed on every `SEED_MILESTONE` event. A player who
rejoins the server several times in one day generates several completed sessions, so the
progression channel gets several near-identical posts — spamming it down.

## Goal

Post the **Seed Progress** embed and the **milestone** embed at most once per player per day.
Grant/extend/thank actions are unchanged.

## Approach

Mirror the existing `seed_thanks` once-per-day pattern already used for the seeder thank-you.
It is DB-backed (survives bot restarts, matching the "no in-memory state for user-facing state"
preference) and reuses the existing pure gate `shouldRunForPeriod(lastDate, today)` — no new
pure-logic function is needed.

### 1. Schema (`src/database/schema.js`, beside `seed_thanks`)

```sql
CREATE TABLE IF NOT EXISTS seed_post_log (
  steam_id VARCHAR(20) NOT NULL,
  post_type VARCHAR(16) NOT NULL,        -- 'progression' | 'milestone'
  player_name VARCHAR(255) NULL,
  last_posted_date DATE NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (steam_id, post_type)
)
```

One row per (player, post_type). Markers are **separate per type** so a day's progression post
does not suppress a same-day milestone (the bigger event) and vice-versa. Self-applies on boot
via `initSchema`.

### 2. Service helpers (`seedTrackerService.js`)

Mirror `getLastThankedDate` / `recordThanked`:

- `getLastPostDate(steamId, postType)` -> `YYYY-MM-DD | null`
- `recordPost(steamId, name, postType, dateStr)` -> upsert marker

### 3. Gating

- **Progression branch** of `processCompletedSession`: compute
  `today = getTodayDate(cfg.timezone || 'UTC')`, read `getLastPostDate(steamId, 'progression')`,
  gate with `shouldRunForPeriod(lastDate, today)`. If already posted today, return silently.
  Otherwise `recordPost(...)` **before** `channel.send` (at-most-once, same as the thank-you gate;
  worst case on a send failure is a missed cosmetic post, never a spam loop).
- **`processMilestone`**: same gate with `post_type = 'milestone'`.

### Unchanged

`grant` and `extend` stay immediate (one-time meaningful whitelist events). The day boundary
uses the configured seeding timezone, consistent with the thank-you gate.

## Testing

The pure gate `shouldRunForPeriod` is already covered. New code is thin DB wrappers + wiring,
consistent with the (untested) `getLastThankedDate`/`recordThanked` wrappers. Run the existing
suite to confirm no regressions.

## Deployment

Patch-bump `package.json`. Ship to staging (`main`) and production (merge `main` -> `production`).
