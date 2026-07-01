# Seeding Announcer Anti-Spam Fix

Date: 2026-07-01
Status: Approved

## Problem

The seeding announcer (`src/services/seeding/`) spams the seed channel, pinging the
seeder role roughly once a minute. The daily call (`checkDailyCall`) is correctly
guarded by `last_daily_call_date` and is NOT the cause.

The cause is an infinite loop in the monitor scheduler `updateSeedingState`
(`seedingScheduler.js`, 60s tick):

1. Population reaches `seed_threshold` -> `completeSession()` closes the session and
   posts "SEEDING COMPLETE" (`:383-390`).
2. Next tick: `getActiveSession()` returns null. The re-seed branch (`:362-378`) only
   guards on `state.playerCount > 0`, so a **fully seeded** server re-seeds -> posts
   "SEEDING HAS BEGUN" + role ping, starting a new session.
3. Next tick: new session is at/above threshold -> completes again -> posts COMPLETE.
4. Loop, ~1 ping/60s, for as long as the server stays populated.

Secondary issue: `updateCallMessage` (`:481-510`) edits the live call message every
60s regardless of change, because `buildSeedingCallEmbed` appends an always-changing
`Last updated <t:now:R>` field (`seedingEmbeds.js:92-93`). Silent (no notification) but
the message perpetually shows "(edited)".

## Decisions (resolved with stakeholder)

- After a successful seed completion, the announcer MAY re-seed again later the same day
  ("re-seed on collapse"), not one-and-done.
- Re-seed re-arms only on a **genuine collapse**: `0 < pop < reset_threshold`
  (hysteresis vs the completion at `seed_threshold`; a server at 0 / dead never gets a
  call).
- A **60-minute cooldown** between seeding calls is a hard backstop against reset-line
  oscillation.
- Also fix the 60s edit churn (stateless).
- Structure as a pure decision function + `bun:test` coverage (mirrors
  `seederRewardLogic.js`).
- Version bump patch `2.26.3 -> 2.26.4`.
- Deploy to staging then promote to prod; re-enable prod via SQL after verification.

## Design

### 1. Pure decision function

New module `src/services/seeding/seedingLogic.js`, exporting `decideSeedingAction(input)`.
Pure, no I/O, testable — same shape as `seederRewardLogic.js`.

Input (all plain values, computed by the caller):

- `hasActiveSession` (bool)
- `playerCount` (number)
- `peakPlayers` (number) — session peak; only meaningful when `hasActiveSession`
- `seedThreshold` (number)
- `resetThreshold` (number)
- `callPostedToday` (bool) — `last_daily_call_date === today`
- `pastDailyTime` (bool) — `currentTime >= dailyTime`
- `inResetWindow` (bool)
- `minutesSinceLastCall` (number) — now minus `MAX(started_at)` of `seeding_sessions`;
  `Infinity` when there are no sessions
- `reseedCooldownMinutes` (number) — 60

Returns `{ action }` where `action` is one of:

| Order | Condition | Action |
|---|---|---|
| 1 | `hasActiveSession && playerCount >= seedThreshold` | `complete` |
| 2 | `hasActiveSession && playerCount < resetThreshold && peakPlayers >= resetThreshold` | `reset` |
| 3 | `hasActiveSession` (otherwise) | `update` |
| 4 | `!hasActiveSession && callPostedToday && pastDailyTime && !inResetWindow && playerCount > 0 && playerCount < resetThreshold && minutesSinceLastCall >= reseedCooldownMinutes` | `reseed` |
| 5 | `!hasActiveSession` (otherwise) | `noop` |

The two guards new to branch 4 (`playerCount < resetThreshold`, cooldown) are the fix.

### 2. Wire into `updateSeedingState`

`updateSeedingState` becomes a thin dispatcher: gather state, compute the inputs, call
`decideSeedingAction`, and switch on the result to the existing side-effecting helpers
(`postCompletionMessage`, `resetSession`, `updateCallMessage`, `postSeedingCall`).
`updateSessionPeak` still runs each tick before the decision when a session is active.

New service helper `getLastSessionStartedAt()` in `seedingService.js`:
`SELECT MAX(started_at) AS ts FROM seeding_sessions`. Caller converts to
`minutesSinceLastCall` (Infinity when null). Cooldown reference is the CALL time; the
daily call and every re-seed set `started_at`, so this directly rate-limits new calls.
No effect on `checkDailyCall`, which stays guarded by `last_daily_call_date`.

`reseedCooldownMinutes` default lives in `settings.{env}.js` under `seeding`
(code constant, like `schedulerCheckMs`), read via `config.seeding`. Not a DB/website
knob.

### 3. Edit-churn fix (stateless)

- Remove the `Last updated <t:now:R>` field from `buildSeedingCallEmbed`
  (`seedingEmbeds.js`) so the embed is a pure function of state.
- In `updateCallMessage`, build the new embed, then compare its `description` and
  `fields` against the currently displayed message's `message.embeds[0].data`. Skip
  `message.edit()` when both are deep-equal. Compare only `description` + `fields`
  (not the whole APIEmbed) to avoid false diffs from received-embed extras
  (`type`, image `proxy_url`/dimensions). No persisted state; restart-safe.

### 4. Tests (write first)

`src/services/seeding/__tests__/seedingLogic.test.js`, `bun:test`. Cases:

- Full server, no active session, past daily time -> `noop` (the regression).
- Active session at/above threshold -> `complete`.
- Active session, dropped below reset after peaking above it -> `reset`.
- Active session below threshold -> `update`.
- No session, `0 < pop < reset`, cooldown elapsed -> `reseed`.
- No session, `0 < pop < reset`, cooldown NOT elapsed -> `noop` (cooldown backstop).
- No session, pop == 0 -> `noop` (dead server).
- No session, `reset <= pop < seed` -> `noop` (healthy, doesn't need re-rally).
- In reset window -> `noop`.
- Call not posted today -> `noop`.

## Out of scope

- The daily-call and channel-reset logic (working correctly).
- The Seed Tracker reward system (`src/services/seedTracker/`).
- Website `/seeding` config UI.

## Release

- `fix(seeding): ...` conventional commit; version `2.26.4`.
- Push `main` -> staging auto-deploys; verify `gh run list` green + container `Up`.
- Merge `main` -> `production` -> prod; verify.
- After prod confirmed, set `Royal_secretary_prod.seeding_config.enabled = 1` via SQL on
  the VPS (bypassing the flaky GUI save); confirm panel + daily call resume.
- No slash-command changes -> no `deploy-commands`.
