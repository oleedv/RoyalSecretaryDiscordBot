# Prospect vote: 6h start / 16h accept + off-Discord catch count

**Date:** 2026-08-18
**Feature:** split the playtime gate so votes can start at 6h while acceptance still requires 16h; persist and display how many times a prospect was caught in-game without Discord voice
**Area:** `src/services/prospect/`, `src/services/commsWatch/`; website `RoyalBattalionWebpage` prospect API + UI
**Version target:** bot 2.35.1 → 2.36.0 (new behaviour)

## Background

The scheduler currently withholds the public vote until the prospect has **16h gameplay** on our server (`getPlaytime().playtimeHours`). Staff can Force Vote earlier. Vote finalization only looks at vote counts (10 yes and 80% yes). Hours are not checked again.

Comms-watch already posts a staff-ticket embed each time an accepted prospect is in **live** play for ~15 minutes without Discord voice (seeding is exempt; one alert per episode). Those messages are not counted, not stored, and not shown to voters or on the website.

Staff want votes to start sooner so members can vote while the prospect is still grinding hours, but a prospect who never reaches 16h must not be accepted. Voters also need a simple signal of how often the prospect skipped Discord.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Vote start threshold | **6h gameplay** (`playtimeHours`). Seed hours do not count. |
| Acceptance hours | **16h gameplay** still required at vote end. Passing votes without 16h = **denied**. |
| Who enforces the 16h deny | Scheduler auto-end **and** staff **End Vote**. There is no post-vote staff Accept button; both end paths go through `finalizeVote`. Interview **Accepted** (starts the prospect period) is unrelated and unchanged. |
| Force Vote under 6h | Still allowed. Warning on the vote embed if under 16h. 16h deny still applies at end. |
| Hours warning on vote embed | Shown when gameplay hours at embed build time are **< 16**. |
| What “caught” means | One count per existing staff-ticket comms alert (15 min live play, not seeding, one per episode). |
| Storage | New `prospect_comms_alerts` table, one row per Discord alert message. Count = `COUNT(*)`. |
| Website | A number (`offDiscordCount`) on staff Tickets → Prospects detail **and** the public `/prospect/[uuid]` page. No incident list. |
| Backfill | Scan **open** staff ticket channels for historical alert embeds. Closed tickets cannot be reconstructed (channel is deleted; alerts were never written to `prospect_messages`). |
| Mid-vote embed updates | When a new alert is posted (or backfill finds one) and a vote message already exists, rebuild the public vote embed so the count (and hours warning) stay current. |

## 1. Hour thresholds

Two config keys on `config.prospects`, set in `settings.js` / `settings.development.js` / `settings.staging.js` / `settings.production.js`:

- `voteStartHours: 6`
- `voteAcceptHours: 16`

All comparisons use **gameplay hours** from `getPlaytime()` (`playtimeHours`), the same source as today’s 16h gate. Seed hours are ignored.

### Vote start (`prospectScheduler.runVoteCheck`)

Replace the hardcoded `< 16` skip with `< voteStartHours`.

Staff “Insufficient Playtime” ticket warning (fired once after period end while still under the start gate) changes 16 → `voteStartHours` in both the hour figure and the “posted automatically once they reach …” copy. Force Vote remains the escape hatch.

Test Steam IDs (`isTestSteamId`) still skip the playtime fetch and always post.

If `getPlaytime` returns `null` (outage), **do not block** the vote. Same as today: missing stats are treated as “not below the gate”.

### Vote embed warning

`buildVoteEmbed` takes the playtime stats it already receives.

When `playtimeHours < voteAcceptHours` (and this is not a test Steam ID with no playtime), add a full-width field:

- **Name:** `Hours requirement`
- **Value:** `This prospect has not completed the required 16 hours in-game. The vote will still run, but they cannot be accepted until they reach 16 hours.`

Use the config value in the sentence so the copy stays correct if the number changes. No colour change — the vote embed stays yellow (`0xfee75c`).

When hours are `>= voteAcceptHours`, or playtime is unknown (`null`), omit the field.

### Vote end (`finalizeVote`)

Used by the scheduler and by staff **End Vote**. After the existing vote-threshold checks, fetch live playtime (skip for test Steam IDs).

```
votesOk  = yes >= minYesVotes AND yesRate >= minYesRate
hoursOk  = test steam ID
        OR playtime is null          // unverified: do not deny on hours
        OR playtimeHours >= voteAcceptHours
outcome  = (votesOk AND hoursOk) ? accepted : denied
```

If playtime is `null` at end, post a staff-ticket info line that hours could not be verified and the 16h rule was skipped. Do not fail closed on an API outage.

Staff-ticket threshold summary (already posted on deny) adds an hours line when hours were the blocker, e.g. `8.4/16 required gameplay hours`.

`closeProspect` deny reason (DM + event detail):

| Cause | Reason string |
|---|---|
| Votes failed, hours ok or unverified | `The membership vote did not pass.` |
| Hours failed, votes passed | `The 16-hour in-game requirement was not met.` |
| Both failed | `The membership vote did not pass, and the 16-hour in-game requirement was not met.` |

### Force Vote (`handleTestVote`)

Still posts regardless of hours. If playtime is present and `< voteAcceptHours`, keep a staff ephemeral warning that they are under the accept threshold and will be denied at end unless they reach it. Update the current “16h required / posting anyway” copy to talk about the **accept** bar, not a start bar.

### Non-changes

- Application panel (`prospectPanel.js`) still says the prospect phase asks for **16 hours**. That is the acceptance requirement.
- Interview **Accepted** only starts the prospect period. It is not a vote-end override and is not changed.
- After a vote, the only accept/deny path is `finalizeVote` (scheduler or **End Vote**). There is no staff button that can accept someone who is under 16h.

## 2. Off-Discord catch count

### Schema (secretary DB, bot-owned)

```sql
CREATE TABLE IF NOT EXISTS prospect_comms_alerts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  prospect_id INT NOT NULL,
  discord_message_id VARCHAR(20) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_message (discord_message_id),
  INDEX idx_pca_prospect (prospect_id),
  FOREIGN KEY (prospect_id) REFERENCES prospects(id)
)
```

Added in `src/database/schema.js` next to the other prospect tables. No counter column on `prospects` — the count is always `COUNT(*)` so it cannot drift from the rows.

### Live write path

In `postProspectAlert` (`commsWatchMonitor.js`), after a successful `channel.send`:

1. Resolve `prospect_id` from the tracked identity (add `id` to `getOpenProspects()` / the tracked object; it is already selected as `id`).
2. `INSERT IGNORE` a row with that `prospect_id` and the sent message id.
3. If the prospect has `vote_message_id` set, rebuild and edit the public vote embed (see below).

A failed insert must not throw away the already-posted staff alert. Log and continue.

### Count helper

`getCommsAlertCount(prospectId)` → number. Used by `postVote`, vote-embed refresh, and tests.

### Vote embed Discord field

Always shown (already is). Add a third line:

```
Hours: **11.2h**
Messages: **34**
Off Discord: **3 times**
```

Use `1 time` / `N times`. Show `0 times` when there are no rows — voters should see a clean record, not a missing field.

### Mid-vote refresh

Extract a small `refreshVoteEmbed(prospect, client)` used by `postVote` (initial build) and by the live alert path.

Rebuild from **live** playtime + voice + messages + combat + `getCommsAlertCount`. Consequences:

- Off-Discord line is current.
- The hours-requirement field appears iff **current** gameplay hours are still `< voteAcceptHours`. If they grind to 16h during the vote, the warning disappears. Vote end still re-checks live hours.

Only the embed is edited. Vote buttons / counts stay as they are (`interaction.message.edit` already updates components on vote; this path must not reset them). Fetch the vote message and `edit({ embeds: [newEmbed] })` only.

If the forum thread or vote message is gone, log and skip.

## 3. Backfill

Alerts were never stored in `prospect_messages` (that table is human chat only). Staff ticket channels are deleted on close. Therefore:

- **Open** prospects: scan `prospect.channel_id` on startup.
- **Closed** prospects: count stays 0. No attempt to recover.

`backfillProspectCommsAlerts(client)`:

1. Load open prospects with `channel_id` and `period_started_at IS NOT NULL` (same population comms-watch alerts).
2. For each channel, paginate messages (100 at a time).
3. Keep bot messages whose first embed title is exactly:
   - `Prospect not on Discord while in-game` (current)
   - `Prospect off comms while in-game` (pre-2026-07-10)
4. `INSERT IGNORE` `(prospect_id, message.id, message.createdAt)`.
5. After a prospect’s scan, if they have a `vote_message_id`, refresh that vote embed once.

Idempotent via `unique_message`. Safe to run on every process start; cheap when every historical message is already inserted.

Call it once from comms-watch scheduler start (or bot ready, after the Discord client can fetch channels). Do not block the first monitor tick if the scan is slow — run it without awaiting the whole guild in the tick path. A one-shot `backfillRunning` guard prevents overlap with a second start.

## 4. Website (`RoyalBattalionWebpage`)

The API already reads the secretary DB (`getSecretaryDb()`). No bot HTTP API.

- `packages/shared/types/tickets.ts`: add `offDiscordCount: number` to `Prospect`.
- `packages/api/src/routes/prospects.ts`: on `GET /:id` and `GET /by-uuid/:uuid`, query
  `SELECT COUNT(*) FROM prospect_comms_alerts WHERE prospect_id = ?`
  and map to `offDiscordCount`. Treat a missing table / error as `0` so a website deploy before the bot migration does not 500.
- Staff UI: `packages/web/app/(protected)/tickets/page.tsx` `ProspectDetail` info grid — label `Off Discord`, value `N times`.
- Public UI: `packages/web/app/(public)/prospect/[uuid]/page.tsx` — same field in the application-info grid.
- `exportProspectText` includes the number.

No list-row badge, no dated incident list, no change to `RB-balance-attribution` (not the deployed site).

## 5. Tests

Bot:

- `buildVoteEmbed`: hours-requirement field present when playtime `< 16`, absent when `>= 16` or playtime missing; Discord field always has the Off Discord line including `0 times`.
- `finalizeVote`: votes pass + hours `< 16` → denied with hours reason; votes pass + hours `>= 16` → accepted; votes fail + hours `< 16` → combined reason; playtime `null` → hours rule skipped.
- Scheduler copy / comparison uses `voteStartHours` (unit-test the predicate if the scheduler stays integration-heavy).
- Comms-watch: after a successful alert send, an insert is attempted; duplicate message id does not throw.
- Backfill matcher accepts both embed titles and ignores unrelated bot embeds.

Website: no new page tests required beyond type/API mapping if the repo has no existing prospect-page tests. Do not add a snapshot farm.

## Files

**Bot**

- `src/database/schema.js` — new table
- `settings.js`, `settings.development.js`, `settings.staging.js`, `settings.production.js` — `voteStartHours`, `voteAcceptHours`
- `src/services/prospect/prospectScheduler.js` — 6h start gate + staff warning copy
- `src/services/prospect/prospectVoting.js` — hours check in `finalizeVote`; pass alert count into embed
- `src/services/prospect/prospectEmbeds.js` — warning field + Off Discord line
- `src/handlers/prospectButtons.js` — Force Vote warning copy
- `src/services/commsWatch/commsWatchService.js` — insert, count, backfill
- `src/services/commsWatch/commsWatchMonitor.js` — write on alert; trigger embed refresh
- `src/services/prospect/__tests__/prospectVoteEmbed.test.js` — extend
- new unit tests for finalize hours logic and backfill title matching

**Website**

- `packages/shared/types/tickets.ts`
- `packages/api/src/routes/prospects.ts`
- `packages/web/app/(protected)/tickets/page.tsx`
- `packages/web/app/(public)/prospect/[uuid]/page.tsx`

## Out of scope

- Changing the 15-minute comms threshold, seeding exemption, or member board behaviour
- Showing an incident timeline on the website
- Reconstructing counts for closed / deleted tickets
- Blocking Force Vote under 6h
- Adding a staff override that can accept a vote without 16h
- Changing the Join-RB panel’s “16 hours” requirement text
- Deploying the same UI to `RB-balance-attribution`

## Deploy

- Version bump: **2.35.1 → 2.36.0**
- Additive schema: website can ship before or after the bot. Before: counts render as 0. After: live + backfilled numbers appear.
- Bot deploy mapping unchanged: push `main` → staging; merge `main` → `production` and push `production` → prod.
- Website deploy is independent. Ship the API field and the two UI surfaces together.
