# Monthly Giveaway — Engineering Reference

Living engineering doc for the giveaway feature. Keep this updated as bugs are found, fixes shipped, and behavior changes.

> **For future Claude / future Ole:** This is the place to look first when something breaks. Source of truth for what the feature does, where its code lives, and what's already been tried.

## Origin

- **Spec:** `docs/superpowers/specs/2026-06-03-monthly-giveaway-design.md`
- **Plan:** `docs/superpowers/plans/2026-06-03-monthly-giveaway.md`
- **Test checklist:** `docs/superpowers/plans/2026-06-03-monthly-giveaway-test-checklist.md`
- **User guide:** `docs/giveaway-guide-discord.md`
- **Requested by:** Onion (Trainee Admin), 2026-05-08
- **Shipped:** 2026-06-03 in v2.5.0, branch `feat/giveaway-system` merged ff to `production`

## What it does

Monthly raffle run from Discord or the website `/giveaway` page. People earn tickets by playing on RB (hours + seed hours), with a small RB-only community vote bonus. At month end a staff member runs the draw — weighted random pick, posts the winner.

Website start/draw/cancel/open-vote/add-entry go through `pending_actions` (`giveaway_start`, `giveaway_open_vote`, `giveaway_draw`, `giveaway_cancel`, `giveaway_add_entry`, `giveaway_refresh_entry`). Default channels and ticket rules live in `giveaway_config` (id=1) and are copied onto each new giveaway row.

**Scope as shipped:** RB members only. Non-RB community members can only enter via `/giveaway add-entry` (staff manual entry). Self-serve Steam linking for the wider community is deferred to a separate spec.

## Module layout

```
src/
├── commands/
│   └── giveaway.js                  ← slash command, 6 subcommands
├── handlers/
│   └── giveawayButtons.js           ← Enter + Vote button handlers
├── services/giveaway/
│   ├── giveawayService.js           ← DB CRUD + leaderboard composition
│   ├── giveawayMath.js              ← pure: computeTickets()
│   ├── giveawayDraw.js              ← pure: pickWinner() (weighted random)
│   └── giveawayEmbeds.js            ← all embed + button builders
├── events/
│   └── interactionCreate.js         ← MODIFIED: routes giveaway_enter:/giveaway_vote: prefixes
└── database/
    └── schema.js                    ← MODIFIED: added 3 tables

tests/unit/giveaway/
├── giveawayMath.test.js             ← 5 tests, pure
└── giveawayDraw.test.js             ← 7 tests, pure (includes 10k-iteration weighting check)
```

No other files in the repo were touched.

## Database

Three tables in `Royal_secretary` (secretary pool):

### `giveaways`
Root entity. One row per giveaway, status flows `open → voting → drawn` (or `cancelled` from anywhere). Knobs (`min_hours`, weights, `votes_per_voter`) live here so they're tunable per giveaway without code edits.

### `giveaway_entries`
One row per entrant. `steam_id` set for linked entries, `manual_hours`/`manual_seed` set for manual entries (mutually exclusive in practice, not enforced at schema level). `UNIQUE KEY (giveaway_id, user_id)` prevents duplicates — re-clicking Enter is a safe upsert.

### `giveaway_votes`
One row per vote. `UNIQUE KEY (giveaway_id, voter_id, target_id)` enforces "can't vote twice for same person" at DB level. Cap (`votes_per_voter`) is enforced in `castVote()` at app layer with a COUNT check before INSERT.

Full DDL is in `src/database/schema.js` — search for "Giveaway tables". Idempotent (`CREATE TABLE IF NOT EXISTS`); safe to re-deploy.

## Data flow

```
┌─────────────────┐
│ /giveaway start │ → INSERT giveaways → post entry embed → UPDATE entry_message_id
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────┐
│ User clicks "Enter Giveaway"    │
│ → getStoredSteamId (website DB) │
│ → getPlaytime (squadjs DB)      │
│ → if eligible: addLinkedEntry   │
└────────┬────────────────────────┘
         │
         ▼
┌────────────────────────────────────┐
│ /giveaway add-entry (staff manual) │ → upsertManualEntry
└────────┬───────────────────────────┘
         │
         ▼
┌────────────────────────────────────┐
│ /giveaway open-vote                │ → listEntries → buildVoteMessages
│                                    │ → channel.send(...) for each page
│                                    │ → setVoteMessage (status → 'voting')
└────────┬───────────────────────────┘
         │
         ▼
┌────────────────────────────────────┐
│ RB member clicks vote button       │
│ → memberRoleId check               │
│ → castVote (self/cap/duplicate)    │
└────────┬───────────────────────────┘
         │
         ▼
┌────────────────────────────────────┐
│ /giveaway draw                     │
│ → computeLeaderboard (live SquadJS) │
│ → pickWinner (weighted random)     │
│ → markDrawn → post winner embed    │
└────────────────────────────────────┘
```

## Cross-service dependencies

- **`playtimeService.getPlaytime(steamId, startDateIso)`** → `{ playtimeHours, seedHours }` from SquadJS DB. Bug here = wrong ticket counts.
- **`userService.getStoredSteamId(discordId)`** → from website's `User.steamId`. Bug here = legitimate users told "link your Steam first".
- **`config.prospects.memberRoleId`** → RB member role gate for voting. If this is wrong/null, voting is either open to everyone (null = no gate) or closed to everyone (wrong ID).
- **`utils/embed.js`** → `successEmbed`, `errorEmbed` for ephemeral responses.

## Configuration

No new config knobs added — feature reuses `config.prospects.memberRoleId` for the RB-member check. Per-giveaway rules are columns on the `giveaways` row, defaulted at INSERT time in `createGiveaway()`:

```js
windowDays = 30, minHours = 5.0,
hoursWeight = 1.0, seedWeight = 2.0,
voteWeight = 1, votesPerVoter = 2
```

To change defaults, edit `createGiveaway()` in `giveawayService.js`. To change for an in-flight giveaway, UPDATE the column directly in the DB.

## Debugging playbook

When something breaks, work through these in order.

### "Bot says I have 0 tickets but I've played all month"

1. Check Discord↔Steam link:
   ```sql
   -- on website pool
   SELECT discordId, steamId FROM User WHERE discordId = '<user_id>';
   ```
   No row or null `steamId` → user needs to verify panel.

2. Check SquadJS playtime in the lookback window:
   ```sql
   -- on squadjs pool
   SELECT
     SUM(c.session_duration)/3600 AS hours,
     SUM(c.seed_duration)/3600 AS seedHours
   FROM squadjs_connections c
   JOIN squadjs_players p ON p.id = c.player_id
   WHERE p.steam_id = '<steam_id>'
     AND c.event_type = 'leave'
     AND c.time >= DATE_SUB(CURDATE(), INTERVAL 30 DAY);
   ```
   <5h here = not eligible. Adjust `min_hours` on the giveaway row if needed.

3. Check entry exists:
   ```sql
   SELECT * FROM giveaway_entries WHERE giveaway_id = <id> AND user_id = '<discord_id>';
   ```
   Missing = user never clicked Enter (or click silently failed; check bot logs around their click time).

### "RB member can't vote — bot says restricted"

`config.prospects.memberRoleId` mismatch with what they have in Discord. Verify in `settings.production.js` (or whichever env). If you recently re-rolled the role ID, that's the cause.

### "Manual entry doesn't show on leaderboard"

`computeLeaderboard()` reads via `listEntries()`. Confirm the row exists with `manual_hours IS NOT NULL`. If it's there but tickets are 0, check `weights` are sane — `Number(giveaway.hours_weight)` returning NaN means the column has a bad value.

### "Vote button has no effect"

1. Check `interactionCreate.js` registers the `giveaway_vote:` prefix — Task 20's diff at `src/events/interactionCreate.js`.
2. Check container has v2.5.0+: `docker exec royal-secretary-bot-prod cat package.json | grep version`.
3. Check bot logs for an error trace from `handleVote`.

### "Slash command doesn't appear in Discord"

Slash commands are registered separately from code deploy. Re-run:
```bash
ssh -i ~/.ssh/royal_infra oleed@54.38.242.227 \
  "docker exec royal-secretary-bot-prod bun run deploy-commands"
```

### "Draw picks weirdly"

Run unit tests: `bun test tests/unit/giveaway/giveawayDraw.test.js`. The 10k-iteration weighting test catches distribution bugs. If tests pass but real draws look wrong, the issue is in `computeLeaderboard()`, not `pickWinner()` — verify ticket counts shown in the winner embed match what's actually in the entries/votes tables.

## Known limitations (intentional, deferred)

These are deliberately out of scope. Don't "fix" them without confirming the scope expansion:

- **No self-serve Steam linking for non-RB.** Manual entry only. Phase 2 spec.
- **No webpage UI.** Discord-only. Phase 2 if it ever ships.
- **No auto-draw at month end.** Onion runs `/giveaway draw` manually. Adding a scheduler is a clean follow-up if requested.
- **Single prize per giveaway.** No 1st/2nd/3rd. Schema doesn't model this — adding it would need a new `giveaway_prizes` table or a JSON column.
- **Vote post sees self-vote button.** Filtered at click time, not at button render. Cheaper than recomputing per-viewer.
- **Hours snapshot is at draw time** (not entry time). If someone gains hours between Enter and Draw, those count. If they lose access mid-month, current 30-day window still considers them. This is by design.
- **`Math.random()` for weighted pick.** Not cryptographically secure. Acceptable for a community raffle; if challenged, swap for `crypto.randomBytes` in `pickWinner` (interface stays the same — `rng()` injection is already supported).
- **Bot must be running for clicks.** No queue/retry. If bot is down, click is lost — user has to click again when bot is back.

## Future change checklist

When modifying this feature, check off:

- [ ] Did you change a default in `createGiveaway()`? Existing rows in the DB still have old values — only new giveaways pick up new defaults. Update existing rows manually if needed.
- [ ] Did you change a column name? Search for it in `giveawayService.js`, `giveawayEmbeds.js`, and `giveawayButtons.js` — column references are bare strings.
- [ ] Did you add a subcommand? Register it in three places: `addSubcommand(...)` on the builder, the `if (sub === ...)` dispatch in `execute`, and the handler function at file bottom. Re-deploy slash commands.
- [ ] Did you add a button? Register the prefix in `src/events/interactionCreate.js` (button branch).
- [ ] Did you touch schema? Schema migrations are `IF NOT EXISTS` / `ALTER ... IF NOT EXISTS` — they re-run safely on every boot. Don't drop columns without a migration plan.
- [ ] Did you bump `package.json` version? CI tags images by it. Per [feedback_semver_bump_on_push] memory: bump on every push.

## Change log

| Date | Version | Change | Commit |
|------|---------|--------|--------|
| 2026-06-03 | 2.5.0 | Initial implementation | `dc9e6a9` |
| 2026-06-15 | 2.9.3 | Live-update the public entry message's "Entries so far" count on every new entry (button enter + manual add). New `giveawayMessage.refreshEntryMessage()` + `countEntries()`. Previously the count was posted once at `0` and never refreshed. | _pending_ |
