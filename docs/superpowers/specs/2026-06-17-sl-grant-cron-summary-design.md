# SL grant cron — change-gated summary + candidate report file

Date: 2026-06-17
Status: Approved
Area: `src/services/sl-reward/`

## Problem

The SL grant cron (`grantCron.js`) posts a run-summary embed to the hypercare
channel on every run while `hypercareVerbose` is on (~every 30 min), which is
noise when nothing happened. The summary also shows only counts, not which
players were involved.

## Goals

1. Post the run summary **only when the run did something** (activity), not on
   every interval.
2. Include the **full candidate list** with the action taken for each.
3. Deliver the list as an uploaded **`.txt` file** (staff-report convention:
   metadata header + aligned plain-text table), not an embed dashboard.

## Definition of "activity"

`activity = grants > 0 || extensions > 0 || dmsQueued > 0 || flushed.sent > 0`

- grant / extend → whitelist state changed.
- queued DM → a reward DM failed and was queued for retry.
- redelivered DM (`flushed.sent`) → a previously-failed reward DM finally went out.

A run with candidates but only skips (e.g. everyone already whitelisted) is **not**
activity and stays silent.

## Behavior

### `grantCron.js`
- In the per-candidate loop, append an outcome row for **every** candidate:
  `{ name, steamId, hours, action, reason, discordId }`.
  - `action` ∈ `grant | extend | skip`; `reason` from `decideRewardAction`.
  - `discordId` only where already resolved (grant/extend paths call
    `getWebUser`). Skipped rows leave it blank — steam id is the durable key and
    resolving discord for every skip would add a DB query per run for no benefit.
- After the loop compute `activity` (above).
  - **activity** → call `hypercareSend` with the run-summary embed **and** the
    candidate `.txt` attachment, **regardless of `hypercareVerbose`**.
  - **no activity** → do not post the summary (pino log unchanged).
- Removes the old `verboseOnly: !(grants||extensions)` gating on the summary.
- Per-action grant/extend embeds keep `verboseOnly: true` (unchanged).

### `report.js` (new, pure)
- `buildCandidateReport(rows, meta) -> string`.
- `meta`: `{ nowIso, env, dry, thresholdHours, rewardDays, candidates, grants, extensions, skips, dmsQueued, dmsRedelivered }`.
- Output: metadata header + separator + aligned table.
- Rows sorted: grants, then extends, then skips; within a group, hours desc.
- No I/O — unit-testable.

Example:

```
SL Grant Cron Run — 2026-06-17 14:30 UTC
Environment: production | Dry-run: no
Threshold: 5.0h rolling 7d | Reward: 7 days
Candidates: 4 | Granted: 1 | Extended: 1 | Skipped: 2 | DMs: queued 0 · redelivered 1
------------------------------------------------------------
NAME              HOURS  ACTION  REASON            STEAM
PlayerOne          6.3   GRANT   first_grant       7656119...
PlayerTwo          5.1   EXTEND  near_expiry       7656119...
PlayerThree        8.0   SKIP    has_other_wl      7656119...
PlayerFour         5.5   SKIP    still_active      7656119...
```

Attached as `sl-grant-run-<timestamp>.txt`.

### `hypercareLog.js`
- Extend signature to `hypercareSend(client, embed, { verboseOnly = false, files } = {})`.
- Forward `files` to `channel.send({ embeds: [embed], files })`.
- Backwards-compatible: no `files` → current behavior.

## Testing

- `report.test.js` (colocated, `bun test`): header counts, action grouping/sort,
  blank-discord rows, empty-candidate case.

## Housekeeping

- Bump `package.json` 2.15.0 → 2.16.0 (feat).
- Commit: `feat(sl-reward): gate cron summary on activity, attach candidate report`.
- Deploy is separate (push `main` = staging); not done unless requested.

## Out of scope

- Changing the cron interval or thresholds.
- Resolving discord for skipped candidates.
- Posting candidate lists on no-activity runs.
