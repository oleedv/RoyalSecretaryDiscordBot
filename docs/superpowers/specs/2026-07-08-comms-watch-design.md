# Comms Watch — in-game players not on Discord voice

**Date:** 2026-07-08
**Status:** Approved
**Version target:** bot 2.30.2 → 2.31.0 (minor)

## Problem

Members and prospects are required to be on Discord voice comms while playing on
our Squad server. Now that every member's Steam ID and Discord ID are linked, we
can correlate the live in-game roster with Discord voice presence and surface who
is playing **without** being on comms.

Two consumers of one data pipeline:

1. **Live staff board** — a slash command spawns a single auto-updating embed
   listing our people who are in-game but not in a voice channel. Updates ~every
   2 min with a "last updated" stamp.
2. **Prospect alerter** — a background watcher that, when a prospect has been
   in-game without voice for **> 15 min continuously**, posts an alert into that
   prospect's private channel and pings their mentor.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| What is "on Discord" | Connected to **any voice channel except the guild AFK channel**. Mute/deafen ignored. |
| Tracked group | **Members** (WhitelistEntry `role='Member'`, active) **+ actual Prospects** (`prospects.status='open'` **and** `period_started_at IS NOT NULL` — interview accepted; unclaimed/pre-accept application tickets are not tracked for alerts). |
| Board content | **Only violators** (in-game, not on voice). Each row: mention + in-game name + off-comms duration + `[Member]`/`[Prospect]`. |
| Servers | **Main only** = `squadjs_servers.id` 1, config-driven (`serverId`, resolved via `getServerStateById` like the seeding announcer) so Battle (id 2) can be flipped on later. |
| Panel model | **Single canonical persistent panel**; re-running the command moves it. Channel+message id stored in `bot_state`. Survives restart. |
| Command permission | **Staff only** (`config.prospects.roles`, via `requireRole`). |
| Blip grace | Brief voice in/out (< ~60 s) does not flip state or reset the timer. |
| 15-min basis | **Continuous** off-comms; joining voice past the grace resets it. |
| Re-alerting | **One alert per episode**; re-arm only after the prospect rejoins voice or leaves the game. |
| Mentor ping | Ping the assigned `mentor_id`; if unclaimed, ping `mentorRoleId`. |
| Alert destination | The prospect's own private channel (`prospects.channel_id`). |
| Background run | **Always-on** monitor (independent of the board). The board is an optional view. |
| Rollout | Enabled in **all environments** via a config flag defaulted `true` (killswitch, not a gate). |

## Architecture

One shared monitor scheduler tick (~60 s, `createScheduler`) drives everything:

```
tick(client):
  cfg = config.commsWatch (enabled? serverName, graceMs, thresholdMs, boardRefreshMs, afkChannelId)
  if !enabled: return
  roster = seedingSocket.getServerStateById(cfg.serverId)   # 1 = Main (as seeding announcer does)
  if roster unavailable/disconnected: return        # never act on stale/absent data
  tracked = classify(roster.players)                # members + open prospects, resolved to discordId
  voiceSet = non-AFK voice member ids from guild.voiceStates.cache
  for each tracked person:
     prev = state row; obs = {inGame:true, inVoice: voiceSet.has(discordId)}
     next = evaluateComms(prev, obs, now, {graceMs, thresholdMs})   # PURE
     persist next
     if next.shouldAlert && kind==='prospect': postProspectAlert(...)
  reset/delete state rows for identities no longer in-game   # re-arms their episode
  refreshBoard(client)                                       # edit stored panel if any
```

### Components (`src/services/commsWatch/`, mirroring `seeding/`)

- **`commsWatchState.js`** — *pure*, no I/O. `evaluateComms(prev, obs, now, opts)` is the
  debounced state machine (grace both directions, continuous off-comms timer, episode
  dedup). Plus `formatDuration(ms)`. Fully unit-tested.
- **`commsWatchService.js`** — DB layer: classify identities (prospects by `steam_id`,
  members by `WhitelistEntry` + `getDiscordIdBySteamId`), read/write `comms_watch_state`,
  read/write the board pointer in `bot_state`.
- **`commsWatchEmbeds.js`** — `buildBoardEmbed(violators, serverName, now)` and
  `buildProspectAlertEmbed(prospect, offCommsSince, durationMs, serverName)`.
- **`commsWatchMonitor.js`** — the `createScheduler` tick + `runMonitorTick(client)` +
  `refreshBoard(client)` + `startScheduler/stopScheduler`. Wired in `ready.js`.
- **`src/commands/comms-board.js`** — staff slash command, subcommands `show` (post/move
  the single panel; runs a fresh tick first) and `stop` (remove it).

### Debounced state machine (`evaluateComms`)

Per identity we persist debounced state. On each tick, given `obs.inVoice`:

- If the observed voice-presence changed, record `voiceChangedAt = now`.
- `commsOk` (debounced) flips to the observed value only once the observation has been
  stable for `graceMs`; otherwise it holds its previous value. This absorbs brief blips
  in **both** directions: a < grace voice drop doesn't start an episode, and a < grace
  voice join doesn't reset an ongoing one.
- `offCommsSince` is set to `voiceChangedAt` when `commsOk` first becomes `false`, held
  steady through the episode (so duration grows monotonically), and cleared when
  `commsOk` becomes `true`.
- `offCommsMs = inGame && !commsOk ? now - offCommsSince : 0`.
- `shouldAlert = inGame && !commsOk && offCommsMs >= thresholdMs && !prev.alerted`.
- `alerted` is set once we alert, cleared when they get back on comms; a full session
  reset (leaving the game) clears everything — both re-arm the episode.

### Identity resolution

For each live player carrying a `steamID`:

1. **Prospect?** match `steamID` against the set of **accepted** open prospects' `steam_id`
   (`SELECT ... FROM prospects WHERE status='open' AND period_started_at IS NOT NULL`).
   If matched, `discordId = user_id`, and we get `channel_id`, `mentor_id`, `alias`.
   Prospect classification takes priority. Application tickets (no mentor / not yet
   accepted) are excluded so they never get "Prospect not on Discord while in-game" alerts.
2. **Member?** else `findEntries(steamID)` (website `WhitelistEntry`, active) contains a
   row with `role='Member'`; `discordId = getDiscordIdBySteamId(steamID)`.
3. Otherwise ignore (public player / not required on comms).

A member with no Steam→Discord link can't be voice-checked and is skipped (shouldn't
happen now that all members are linked). Epic-only players (no `steamID`) are excluded.
The prospect path uses only the secretary pool, so it works even if the optional
`website` pool is down.

## Data model

New table (secretary pool, added to `initSchema`). Timestamps are epoch **ms** (BIGINT)
so they round-trip straight into the pure logic:

```sql
CREATE TABLE IF NOT EXISTS comms_watch_state (
  discord_id        VARCHAR(20) NOT NULL PRIMARY KEY,
  steam_id          VARCHAR(20) NULL,
  name              VARCHAR(100) NULL,           -- in-game name (display)
  kind              ENUM('member','prospect') NOT NULL,
  prospect_channel_id VARCHAR(20) NULL,
  prospect_mentor_id  VARCHAR(20) NULL,
  in_game_since     BIGINT NULL,
  observed_in_voice TINYINT(1) NULL,
  voice_changed_at  BIGINT NULL,
  comms_ok          TINYINT(1) NULL,             -- 0/1/null (undecided within initial grace)
  off_comms_since   BIGINT NULL,
  alerted           TINYINT(1) NOT NULL DEFAULT 0,
  updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

Board pointer stored in existing `bot_state` under key `commsWatchBoard` =
`{ channelId, messageId }`.

## Board embed

- Title `Playing without Discord — <serverName>`; amber when there are violators, green
  when empty.
- Violator rows sorted by duration desc: `• <@discordId> — \`in-game name\` — 14m — [Prospect]`.
  (Mentions inside an embed don't ping.)
- Bottom line `Updated <t:unix:R>` plus the standard footer timestamp = the "last updated".
- Empty state: `Everyone in-game is on comms.` / `No members or prospects are in-game.`
- Edit throttling: edit immediately when the violator **set** changes; otherwise refresh
  at most every `boardRefreshMs` (~2 min) for duration ticks. Skip identical renders.

## Prospect alert

Posted to `prospects.channel_id`:

- Content pings the mentor: `<@mentor_id>` (`allowedMentions.users`) or, if unclaimed,
  `<@&mentorRoleId>` (`allowedMentions.roles`).
- Embed: describes `<@user_id> (alias)` off comms on `<serverName>`, with **Since**
  (`<t:...:t>`) and **Duration** fields — the required "when / how long".

## Config (`settings.{production,staging,development}.js`)

```js
commsWatch: {
  enabled: true,
  serverId: 1,             // squadjs_servers.id (1 = Main ENG, 2 = Battle)
  serverLabel: 'Main',     // friendly name shown in embeds
  tickMs: 60000,           // monitor cadence
  boardRefreshMs: 120000,  // max board edit interval for duration ticks (~2 min)
  blipGraceMs: 60000,      // tolerate voice blips shorter than this
  prospectThresholdMs: 900000, // 15 min
  afkChannelId: null,      // null => use guild.afkChannelId
},
```

Reuses existing `config.prospects.roles` (command gate), `config.prospects.mentorRoleId`
(unclaimed ping), and `config.guild.id`.

## Error handling

- Socket unavailable / roster stale → skip the tick (freeze timers), never crash.
- Missing prospect channel, DM/permission errors → log + continue.
- All DB writes wrapped; a single bad identity never aborts the tick.
- `website` pool absence degrades gracefully (members drop out; prospects unaffected).

## Testing (TDD)

Pure `commsWatchState.js` via `bun:test`:

- never-joined-voice member becomes a violator only after the grace, duration grows.
- brief voice drop (< grace) from compliant → stays compliant.
- brief voice join (< grace) during an episode → timer does **not** reset.
- sustained voice join (≥ grace) → clears episode + re-arms alert.
- crossing 15 min → `shouldAlert` once; not again while still off-comms (dedup).
- leaving the game resets state and re-arms.
- `formatDuration` formatting.

Plus classification priority (prospect over member) and empty/violator board rendering
where practical without a live Discord client.

## Rollout / ops

- New table auto-created by `initSchema` on boot; config blocks added to all three envs.
- Environments are isolated (separate guilds + DBs) so "on everywhere" cannot cross-post.
- New slash command requires a manual `deploy-commands` per env (CI does not register):
  `docker exec royal-secretary-bot-{staging,prod} bun run deploy-commands`.
- Deploy: push `main` (staging) and `production` (prod) per the repo's deploy mapping.

## Known limitations

- Main only (config flip enables Battle).
- Epic-only in-game players (no Steam ID) are not matched.
- Socket downtime freezes timers for its duration (deliberate — no acting on stale data).
