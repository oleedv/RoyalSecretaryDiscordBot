# Seeding System Rework — Design

- **Date:** 2026-06-16
- **Status:** Approved (design); pending implementation plan
- **Scope:** Cross-project — SquadJS (data source, no code change), Discord bot (`RoyalSecretaryDiscordBot`), Website (`RoyalBattalionWebpage`)
- **Spec home:** This file lives in the bot repo because the bot is the center of gravity for both features; the website and SquadJS changes are referenced from here.

---

## 1. Goal

Rework the cross-project seeding system to fix correctness bugs and consolidate it, **without** rebuilding the working SquadJS pipeline. Chosen scope: **Fix + consolidate** (keep the SquadJS pipeline, session model, current reward rules, and the daily-call trigger model).

The system spans two features that share the word "seeding":
- **Announcer** (`src/services/seeding/`) — daily seeding call, live population panel, completion message.
- **Tracker** (`src/services/seedTracker/`) — whitelist reward for players who help seed.

## 2. Root causes being fixed

1. **Announcer reads the wrong server.** `getServerState(config.seeding?.seedingServer)` in `src/services/seeding/seedingSocket.js:273-281` silently falls back to the *first* socket connection when the configured name doesn't match a `SQUADJS_SERVERS` entry. Documented in the bot's `CLAUDE.md` as "the typical cause of production showing staging data."
2. **Tracker rewards the wrong server.** The tracker's `squadjs_seed_sessions` queries have **no `server_id` filter** (`src/services/seedTracker/seedTrackerService.js` `getPlayerSeedStats`, `getTopSeeders`), so seeding on Battle/staging counts toward Main's whitelist reward — *even though* SquadJS tags every session with `server_id: this.server.id` (`SquadJS-Royal-battalion/squad-server/plugins/seed-tracker.js:201`). The website's `/seeding-tracker` API queries share the flaw. (`getSeedingRapport` in `seedingService.js:198-245` is also unfiltered.)
3. **Fragmented config + split website.** Announcer config lives in DB (`seeding_config` id=1), tracker rules + server name live in `settings.{env}.js`, and the website splits seeding across `/discord-bot` (SeedingTab, config) and `/seeding-tracker` (player stats).

## 3. Decisions (from design interview)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Rework depth | **Fix + consolidate** (keep SquadJS pipeline, reward rules, trigger model) |
| 2 | Server model | **Separate config per feature**; both = Main today |
| 3 | On bad/unreachable server | **Stay live with explicit "unavailable" state** (Discord + website); never fall back |
| 4 | Config home | **DB single source of truth, website-managed**; server field = validated dropdown |
| 5 | id↔socket bridge | **Carry `server_id` in `SQUADJS_SERVERS`** (`name\|url\|token\|serverId`) |
| 6 | Daily call pings | **Website-editable role list**, default `[Seeder]` |
| 7 | Qualifying seed day | **Any completed seed session** (quality display-only) |
| 8 | Website structure | **One `/seeding` page**, permission-gated sections |
| 9 | Leaderboard audience | **Staff only** (current behavior) |
| 10 | Live status delivery | **Bot writes a status row to the DB**; website reads it |
| 11 | Testing | **Focused unit tests on the risky logic**, TDD where practical |

Decisions made during design write-up and approved by the user:
- **Unavailable at call time:** still post the scheduled call-to-action (time-based ritual), but show population as "unavailable" and don't fire completion/reset until live data returns.
- **OverviewTab:** replace the `/discord-bot` seeding widget with a compact read-only status card linking to `/seeding`.
- **Permissions:** reuse `view:seeding-tracker` (view) + `manage:discord-bot` (admin) to match current behavior and avoid re-granting.
- **Dev:** point dev's `SQUADJS_SERVERS` at the staging SquadJS so the feature is locally testable; default `enabled=false` in dev.

## 4. Server identity model (core fix)

- Canonical identity = **`squadjs_servers.id`** (integer; SquadJS sets it as `this.server.id`).
- `SQUADJS_SERVERS` env format extends from `name|url|token` to **`name|url|token|serverId`**. `parseSquadJsServers` in `src/config.js:12-18` gains a `serverId` field per entry; the socket layer records it on each connection so a `server_id` resolves to a live socket.
- Config stores **`announcer_server_id`** and **`tracker_server_id`** as separate integer fields (both = Main's id today, can diverge later without code changes).
- **No silent fallback.** Remove the "first connection" fallback in `getServerState`/`isConnected`. Resolution rules:
  - **Misconfig** (id has no `squadjs_servers` row, or — announcer — no `SQUADJS_SERVERS` entry carries it): feature enters **"unavailable"**, logs a loud error, fires an admin alert via `errorAlertService`.
  - **Outage** (id valid + entry exists, but socket currently down): **"unavailable"** until reconnect; do not post stale population, do not fire completion/reset.
- Website server field is a **validated dropdown** sourced from `squadjs_servers` (id + name) — selecting a real row is the only option, so the original typo is impossible.

## 5. Config data model (DB single source of truth)

Extend the `seeding_config` row (id=1). On first insert, backfill the tracker fields from the current `settings.{env}.js` `seedTracker` values so production behavior is unchanged.

**Announcer fields:** `enabled`, `channel_id`, `role_ids` (JSON list, default `[<Seeder role id>]`), `seed_threshold`, `reset_threshold`, `daily_time`, `timezone`, `announcer_server_id`, `panel_message_id`, `last_daily_call_date`, `last_reset_date`.

**Tracker fields:** `tracker_enabled`, `tracker_server_id`, `required_seed_days` (10), `rolling_window_days` (30), `whitelist_duration_days` (30), `max_extension_days` (60), `progression_channel_id`, `leaderboard_channel_id`.

**New table `seeding_live_status`** (single row, written by the bot each ~60s monitor tick, read by the website):
`server_resolved_ok` (bool), `socket_connected` (bool), `current_population` (int), `current_layer` (varchar), `active_session_id` (int null), `updated_at` (timestamp). Doubles as the bot's persistent last-known-state across restarts.

`settings.{env}.js` keeps only first-insert defaults. `SQUADJS_SERVERS` (URLs + tokens + serverId) stays an env secret.

## 6. Announcer behavior (kept, with fixes)

Unchanged model: daily scheduled call at `daily_time` → live-updating population embed → completion message at `seed_threshold` → reset below `reset_threshold` → daily channel reset (1h before call) → permanent opt-in Seeder panel (`seeding_join` button adds the Seeder role).

Changes:
- Reads population only from `announcer_server_id`'s socket (via the rewritten `getServerState` that requires an explicit, resolved id — no fallback).
- Pings the `role_ids` list (default just Seeder) instead of a single `role_id`.
- **Unavailable handling:** post the scheduled call-to-action anyway, render population as "unavailable" rather than a number, and suppress completion/reset until live data returns.
- Writes `seeding_live_status` each monitor tick.

## 7. Tracker behavior (kept, with fixes)

Unchanged rules: `required_seed_days` unique days in `rolling_window_days` → `whitelist_duration_days` Seeder whitelist, renewable, capped at `max_extension_days` total. Main-only. A qualifying day = any completed seed session; `quality_score` stays display-only. Keeps DM-on-grant, progression/milestone embeds, monthly leaderboard, daily expiry warnings.

Changes:
- Add **`AND server_id = ?`** (= `tracker_server_id`) to *every* seed-session query: `getPlayerSeedStats`, `getTopSeeders` (bot), `getSeedingRapport` (bot), and the website routes (§8).
- Make the "30-day" text in `seedTrackerEmbeds.js` (grant embed line ~51, DM notification ~72-80) **dynamic** from `whitelist_duration_days`.
- Read `progression_channel_id` / `leaderboard_channel_id` / rules from DB config instead of `settings.{env}.js`.
- If `tracker_server_id` can't be resolved: tracker enters "unavailable", stops rewarding, surfaces the state.

## 8. Website `/seeding` page (one page, permission-gated)

A single dedicated page at `/seeding`:
- **Leaderboard + player search/detail** — staff (`view:seeding-tracker`). Moved from `/seeding-tracker`; all four routes (`/seeding-tracker/leaderboard`, `/player/:steamId`, `/search`, `/stats`) gain a `server_id` filter (= `tracker_server_id`).
- **Live status card** — reads `seeding_live_status`; shows population / active-session, or an "unavailable" banner when `server_resolved_ok` is false or `updated_at` is stale.
- **Admin sections** (`manage:discord-bot`): config editor (with server **dropdowns** from `squadjs_servers` + a `role_ids` list editor + tracker rule fields), "send call now", daily rapport + send-to-Discord, session history.
- Retire the `/discord-bot` **SeedingTab**; replace the OverviewTab seeding widget with a compact read-only status card linking to `/seeding`.
- Old `/seeding-tracker` route **redirects** to `/seeding`.
- Add a `/seeding` entry to the protected-layout `NAV_ITEMS`.
- Shared types (`packages/shared`) updated: `SeedingConfig` gains the new fields (`roleIds`, `announcerServerId`, `trackerServerId`, tracker rules); add a `SeedingLiveStatus` type.

## 9. Testing (focused, TDD where practical)

Unit tests for:
- Server-id↔socket resolution and the no-fallback "unavailable" path (misconfig vs outage).
- Tracker `server_id` filtering (sessions on other servers excluded).
- Reward thresholds: grant at threshold, renewal extension, 60-day cap, non-Seeder-whitelist skip.
- `role_ids` parsing / default.
- Config validation (dropdown id must resolve).

## 10. Rollout

No SquadJS code change. Order:
1. **DB migration** — additive columns on `seeding_config`, new `seeding_live_status` table, backfill tracker config from current settings values. (Run against staging DB then prod DB.)
2. **Env** — update `SQUADJS_SERVERS` to add `serverId` (staging containers → prod containers).
3. **Bot deploy** — server-id resolution, no-fallback/unavailable, `server_id` filters, status-row writer, dynamic embed text, `role_ids` pings. Push `main` (staging) → verify the `[boot] bot environment` line shows resolved server id + connected → merge to `production` (prod).
4. **Website deploy** — new `/seeding` page, dropdowns, status read, `/seeding-tracker` redirect, remove SeedingTab, OverviewTab card. Railway auto-deploy from `production`.
5. **Cleanup** — delete dead code paths (`seedingServer` settings key, old `role_id` single-field usage, `/discord-bot` SeedingTab component).

Semver bump on bot + webpage `package.json` before each push (per project convention). Conventional-commit messages, no AI attribution.

Dev: point dev's `SQUADJS_SERVERS` at the staging SquadJS instance (with its `serverId`) so the feature is locally testable; seed dev `seeding_config` with `enabled=false`.

## 11. Open / to-confirm at implementation

- Exact `seeding_live_status` staleness threshold for the website "unavailable" banner (proposed: 2× monitor interval ≈ 120s).
- Whether `role_ids` is a JSON column on `seeding_config` vs a child table (proposed: JSON column — small, single-row config).
- Whether earning the whitelist should also auto-assign the Discord Seeder role (out of scope unless requested).
