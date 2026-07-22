# Seeding Announcer One-Cycle Lifecycle Fix

Date: 2026-07-22  
Status: Approved (stakeholder interview)  
Repo: `RoyalSecretaryDiscordBot`  
Related: `2026-07-01-seeding-announcer-antispam-design.md` (partial fix; this supersedes its re-seed-on-collapse policy)

## Problem

The seeding channel announcer spammed **SEEDING HAS BEGUN** and **SEEDING COMPLETE** roughly once per minute (role pings included). The announcer was disabled in production as a result.

### Known mechanism

Monitor tick (`updateSeedingState`, ~60s) in `src/services/seeding/seedingScheduler.js`:

1. Population reaches `seed_threshold` → `completeSession` + post COMPLETE.
2. Next tick: no active session.
3. Historical bug (pre-v2.27.2): re-seed if `playerCount > 0` → post BEGUN + new session even on a full server.
4. Next tick: session already at threshold → COMPLETE again → infinite loop.

### Why the July 1 fix is not enough

v2.27.2 (`decideSeedingAction`) only re-seeds when `0 < pop < reset_threshold` and a 60-minute cooldown has elapsed. That stops the *full-server* loop under correct config, but:

- Automatic re-seed same day remains intentional in that design.
- A high or wrong `reset_threshold`, oscillating A2S counts, or other re-arm paths can still produce BEGUN/COMPLETE pairs.
- Stakeholder requirement is now stricter: **at most one automatic cycle per calendar day**.

## Desired channel behavior

1. **Static panel** at the top of the channel (oldest message after a clear): Join Seeders / Leave Seeders buttons. Never deleted by the bot; re-posted if missing.
2. **Once per day at `daily_time`** (config timezone): post a single **SEEDING HAS BEGUN** embed + ping configured seeder role(s). Start one active session. Call embed updates live player count only when meaningful fields change.
3. Users post freely (text, gifs, hype) between BEGUN and COMPLETE.
4. **Once when `playerCount >= seed_threshold`**: post **SEEDING COMPLETE** + ping roles; close the session.
5. No second automatic BEGUN/COMPLETE that day from the monitor.
6. **Night clear**: in the window one hour before next `daily_time`, delete all channel messages except the panel (existing behavior).

## Decisions (interview)

| Topic | Decision |
|---|---|
| Spam cadence observed | ~once per minute (classic loop) |
| Same-day collapse after COMPLETE | No automatic re-seed; one automatic cycle per day only |
| Failed seed day (never hits threshold) | Nothing else automatic; BEGUN stays; no COMPLETE |
| BEGUN trigger | Clock only at `daily_time` (+ catch-up if bot was offline after that time) |
| COMPLETE trigger | Population ≥ `seed_threshold` only (real success) |
| Layer leaves seed under threshold | Session stays active; keep updating BEGUN embed |
| Pop collapse mid-seed | Session stays active; keep updating BEGUN embed |
| Night clear | 1 hour before `daily_time` (current) |
| Panel | After clear, only panel remains; re-post if missing |
| Role pings | On both BEGUN and COMPLETE |
| Call embed edits | On meaningful state change only |
| send-now while session active | Refresh/replace existing call message; do not start a second session |
| send-now after COMPLETE / no session | Staff override: new BEGUN + new session (another COMPLETE allowed for that session) |
| Anti-spam source of truth | DB flags on `seeding_config` (`last_daily_call_date`) + session row status |
| Automatic re-seed | **Removed entirely** from monitor |
| Mid-seed session `reset` action | **Removed** from monitor |
| `reset_threshold` | Remove from bot decision path and hide/remove from website config UI |
| Join/Leave buttons | Grant/remove **all** IDs in `role_ids` |
| Embed copy | Unchanged (behavior-only) |
| Approach | A — hard one-cycle lifecycle |
| Verification | Unit tests + staging dry run one day, then prod re-enable |

## Design

### 1. Lifecycle state (automatic path)

```
[idle]
   |  daily_time reached AND last_daily_call_date ≠ today
   v
[called]  — BEGUN posted, seeding_sessions.status = active
   |  playerCount >= seed_threshold
   v
[completed] — COMPLETE posted, session status = completed
   |
   v  (monitor stays noop until next day / staff send-now)
```

- `last_daily_call_date` is set when the automatic daily call posts (existing).
- Monitor **never** creates a session. Only `checkDailyCall` and staff `send_seeding_call` create sessions.
- After automatic COMPLETE, monitor cannot re-arm. Staff send-now can start a new session (override).

### 2. Pure decision function (`seedingLogic.js`)

Simplify `decideSeedingAction` inputs and outputs:

**Inputs:**

- `hasActiveSession` (bool)
- `playerCount` (number)
- `seedThreshold` (number)

**Actions:**

| Condition | Action |
|---|---|
| `hasActiveSession && playerCount >= seedThreshold` | `complete` |
| `hasActiveSession` (otherwise) | `update` |
| `!hasActiveSession` | `noop` |

Remove: `reseed`, `reset`, and all inputs only used by them (`peakPlayers`, `resetThreshold`, `callPostedToday`, `pastDailyTime`, `inResetWindow`, `minutesSinceLastCall`, `reseedCooldownMinutes`).

### 3. Scheduler wiring (`seedingScheduler.js`)

**Keep (unchanged intent):**

- Dual schedulers: daily check + monitor (~60s).
- `ensureSeedingPanel` / `refreshSeedingPanel` / `findPanelMessage`.
- `checkDailyCall`: reset window wipe; once-per-day BEGUN via `last_daily_call_date`; self-heal wipe if reset missed.
- `resetChannel`: delete non-panel messages; `clearTrackedMessages`; `expireOldSessions`.
- `updateCallMessage`: signature compare; edit only on change.
- `postSeedingCall` / `postCompletionMessage` embeds and dual role pings.
- `writeLiveStatus` every tick regardless of `enabled`.
- No side effects when socket disconnected / server unresolved.

**Change:**

- `updateSeedingState` switch only handles `complete` | `update` | `noop`.
- Delete re-seed branch and cooldown / `getLastSessionStartedAt` usage from the monitor path.
- Stop calling `resetSession` from the monitor.
- Peak tracking (`updateSessionPeak`) may remain for stats/display; it no longer drives a reset action.

### 4. send-now (`actionProcessor.js`)

`handleSendSeedingCall`:

1. Load config; require enabled + `channel_id`.
2. If `getActiveSession()` is non-null: refresh the existing call message (same path as monitor `update`), do **not** insert another session. If call message is missing, re-post call content and bind `call_message_id` to the existing session.
3. Else: `postSeedingCall` (new BEGUN + new session). Does not require `last_daily_call_date` to be unset (staff override after COMPLETE). Optionally set `last_daily_call_date` to today when posting so the clock path does not double-post later the same day if send-now ran early — **yes: if send-now posts a new BEGUN before daily_time, set `last_daily_call_date = today` so the clock does not post a second automatic BEGUN.**

### 5. Buttons (`seedingButtons.js`)

- Configure check: `role_ids.length > 0` (not legacy `role_id` alone).
- Join: add every missing role in `role_ids`.
- Leave: remove every present role in `role_ids`.
- Ephemeral copy stays essentially the same.
- Button count label: member count of the **first** role in `role_ids` (primary), for a stable single number.

### 6. Website / API (`RoyalBattalionWebpage`)

- Remove `resetThreshold` from seeding admin form (`SeedingAdmin.tsx`).
- Stop accepting/returning it in PATCH/GET if practical; or accept but ignore/stop displaying. Prefer remove from shared `SeedingConfig` type and API mapping so the field is gone from the product surface.
- DB column `reset_threshold` may remain unused (no forced migration drop) to avoid downtime risk; bot ignores it.

### 7. Settings cleanup

- Remove `reseedCooldownMinutes` from `settings.*.js` if nothing else reads it after the logic change.
- Remove `defaultResetThreshold` from insert defaults only if schema insert still requires a value — keep DB default for the unused column or insert a fixed legacy default without exposing it in product config.

### 8. Tests

Rewrite `src/services/seeding/__tests__/seedingLogic.test.js`:

- Active + pop ≥ threshold → `complete`
- Active + pop < threshold → `update`
- No active + full server → `noop`
- No active + empty / low pop → `noop`
- No reseed/reset cases remain

Add or extend tests only where pure helpers are extracted for send-now branching (optional if logic stays thin in actionProcessor).

### 9. Out of scope

- Seed tracker / whitelist rewards (`seedTracker/`)
- Embed visual redesign
- Changing `seed_threshold` defaults or daily_time defaults
- Discord true “always sticky above live chat” (impossible without pins; panel is first message after clear only)
- Dropping `reset_threshold` column from MariaDB (optional later)

## Release

1. Implement bot changes + unit tests in `RoyalSecretaryDiscordBot`.
2. Implement website field removal in `RoyalBattalionWebpage` (same release train or immediately after bot).
3. Conventional commits; patch/minor version bump per repo norms.
4. Deploy staging; enable announcer; staging dry run (send-now and/or wait for daily_time).
5. Confirm: one BEGUN, live updates without edit spam, one COMPLETE, no minute loop, panel survives wipe.
6. Promote to production; set `seeding_config.enabled = 1`; watch first live daily window.

## Success criteria

- Monitor cannot post BEGUN.
- Automatic path: ≤1 BEGUN and ≤1 COMPLETE per timezone day (absent staff send-now).
- Staff send-now never creates a second concurrent active session.
- Role pings only on real BEGUN/COMPLETE posts.
- Join/Leave toggles all configured `role_ids`.
- `reset_threshold` no longer appears in website seeding admin or bot decision logic.
- Once-per-minute spam is impossible under this state machine even if the server stays full.

## Supersession note

Relative to `2026-07-01-seeding-announcer-antispam-design.md`:

- **Keep:** edit-on-change call embed; pure decision function + tests; no re-seed while full server.
- **Replace:** “re-seed on genuine collapse + 60m cooldown” with “no automatic re-seed; one automatic cycle per day; staff send-now for extra cycles.”
