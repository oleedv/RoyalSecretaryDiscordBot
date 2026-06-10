# Squad Leader Whitelist Reward — Design

Status: Draft, awaiting user review
Date: 2026-06-10
Owners: Discord bot (primary), SquadJS plugin (tracking), Webpage DB (grant target)

## 1. Summary

Reward players who squad-lead well on the Royal Battalion server with free whitelist. SquadJS gains a new plugin that polls live squad state, persists it, and at round-end aggregates per-player "qualifying SL time." The Discord bot reads those aggregates on a cron and grants/extends whitelist via the existing `WhitelistEntry` table on the webpage DB, attached to the existing "Squadleader whitelist" (`SL`) clan.

Players need only a SteamID (which the game provides) to participate. Discord linking is a bonus that enables DM notifications and a nicer leaderboard display name; it is never required.

## 2. Goals & non-goals

### Goals
- Quantify "good squad leading" automatically using only data SquadJS can capture today plus one new polling plugin.
- Grant 7 days of free whitelist when a player accumulates 5+ qualifying SL hours in a rolling 7-day window.
- Surface progress to players in-game (RCON admin warn on squad formation) and in Discord (live-updating top-20 embed).
- Avoid spamming players who already have whitelist for other reasons (paid, clan member, prospect, etc.).

### Non-goals (MVP)
- Discord slash command `/sl progress` for self-checking — defer.
- In-game `!slprogress` chat command — defer.
- Webpage user-facing SL dashboard — defer.
- Staff admin dashboard / leaderboard view on the webpage — defer.
- Per-server config; this ships for "main" server only.
- Retention pass on other high-volume SquadJS tables (`squadjs_combat_events`, `squadjs_spawns`, `squadjs_chat_messages`, `squadjs_tick_rates`, `squadjs_player_counts`) — separate follow-up project.

## 3. Definitions

- **Qualifying SL tick** — a 30-second poll snapshot where the player held the SL role of a squad with ≥5 members at that moment.
- **Y gate (per round, per squad)** — `squad_strength_s ≥ round_duration_s / 2`, where `squad_strength_s` is the total seconds the squad had ≥5 members during the round.
- **Z gate (per round, per player)** — `sl_tenure_s ≥ round_duration_s / 2`, where `sl_tenure_s` is the total seconds the player held SL during the round.
- **Qualifying SL seconds (per round, per player)** — sum of seconds where (player was SL) AND (squad had ≥5 members), but only contributed by squads that passed Y. Set to 0 for the entire round if Z fails.
- **Rolling 7-day total** — sum of qualifying SL seconds across all of a player's rounds whose `created_at > NOW() - INTERVAL 7 DAY`.
- **Reward threshold** — rolling 7-day total ≥ 5 hours (18,000 s).
- **Reward duration** — 7 days of `WhitelistEntry` with `clanId = SL_CLAN_ID`.
- **`SL_CLAN_ID`** — `cmq8eaiat03ym01qtcdgs7bri` (`Clan.tag = "SL"`, `Clan.name = "Squadleader whitelist"`).
- **Warn-eligible player** — has no active whitelist OR has an active whitelist that includes a row with `clanId = SL_CLAN_ID`.

## 4. Components (MVP)

### 4.1 Discord bot — DM SteamID register button
Add a 3rd button to the DM welcome embed in `src/events/messageCreate.js` (current embed at lines 143–175). Label: "Link SteamID". Marketing copy: "Link your SteamID so the bot can DM you when you earn rewards." Opt-in; not required for participation.

Click opens a modal with one text input (Steam64, 17 digits). On submit:
- Validate Steam64 format (17 digits, leading 7).
- Call a modified `linkSteamId()` in `src/services/userService.js`. Current implementation is first-write-wins. Add an `allowOverwrite` parameter that allows the user-initiated path to overwrite. Existing prospect flow keeps `allowOverwrite: false`.
- DM confirmation back to the user.

### 4.2 SquadJS — `sl-tracking` plugin
New plugin at `squad-server/plugins/sl-tracking.js` extending `BasePlugin`. Responsibilities:

1. **Polling.** `setInterval(30_000)`, calls `this.server.rcon.execute('ListSquads')`, parses output into `[{team, squad_id, squad_name, leader_steam_id, member_count}, ...]`. Resolves `leader_player_id` via `squadjs_players` (cached map by `steam_id`). Inserts one row per squad into `squadjs_squad_ticks`.
2. **Transition detection.** In-memory `Map<squad_id, last_member_count>` per server, reset on `NEW_GAME`. When a tick shows a squad going from `<5` → `≥5`, schedule a warn check (see §5.B).
3. **Round-end aggregation.** Subscribes to `ROUND_ENDED`. Computes per-player, per-round `sl_round_stats` rows using §5.C algorithm.
4. **Pruning.** Daily cron inside the plugin: `DELETE FROM squadjs_squad_ticks WHERE tick_at < NOW() - INTERVAL 60 DAY` and same for `squadjs_sl_warn_log`. `squadjs_sl_round_stats` is kept indefinitely.

Plugin gets a second Sequelize connector (read-only) pointed at the webpage DB (`royal_battalion_prod` / staging equivalent) — used only by the warn-eligibility check.

### 4.3 Discord bot — reward grant cron
Runs every 30 minutes. For each player with `> 0` rolling 7-day qualifying seconds, runs §5.D algorithm: grants new `WhitelistEntry`, extends existing SL-clan entry, or skips. Sends a DM on new grants when the player is Discord-linked. Best-effort DM — DM failure does not block grant.

Dry-run mode: env var `SL_REWARD_DRY_RUN=true` causes the cron to log intended actions without writing.

### 4.4 Discord bot — live leaderboard embed
Runs every 3 hours. Queries top 20 players by rolling 7-day qualifying SL hours across ALL players (linked or not). Builds an embed with rank, display name, hours, and whitelist badge (`✓ SL`, `✓`, `—`). Edits a persisted message in a configured channel; falls back to posting a new message if the persisted ID is missing or stale.

Configuration (env vars):
- `SL_LEADERBOARD_CHANNEL_ID` — required; channel where the embed lives.
- `SL_LEADERBOARD_MESSAGE_KEY` — defaults to `sl_leaderboard_message_id`.

Message ID persistence: a new key/value table (`BotState`) on the webpage DB OR a small JSON file in the bot's data dir. Implementation-time decision based on whether a settings table already exists; default to a JSON file at `data/bot-state.json` if no existing pattern is found.

## 5. Algorithms

### 5.A Tick polling (every 30 s, per server)
```
on interval (30 s):
  ticks = rcon.execute('ListSquads') |> parse
  for each squad s in ticks:
    leader_player_id = playerCache.get(s.leader_steam_id) or
                       ensurePlayer(s.leader_steam_id).id
    INSERT INTO squadjs_squad_ticks
      (server_id, match_id, tick_at, team_id, squad_id, squad_name,
       leader_player_id, member_count)
    VALUES (...)
    prev = lastMemberCount.get(s.squad_id)
    if prev < 5 and s.member_count >= 5 and s.leader_player_id is not null:
      scheduleWarnCheck(match_id, s.leader_player_id, leader_eos_id)
    lastMemberCount.set(s.squad_id, s.member_count)
```

### 5.B Warn-eligibility check + RCON warn
```
on warn check for (match_id, player_id, eos_id):
  if exists in squadjs_sl_warn_log: return

  hours = rolling7dHours(player_id)
  if hours is null or 0: hours = 0

  // Read-only query against webpage DB
  rows = SELECT clanId, expiresAt
         FROM WhitelistEntry
         WHERE steamId = ?
           AND server = 'main'
           AND (expiresAt IS NULL OR expiresAt > NOW())

  if rows is empty:
    eligible = true
  else if any row has clanId = SL_CLAN_ID:
    eligible = true
  else:
    eligible = false

  if eligible:
    lines = [
      'Thanks for squadleading!',
      `Whitelist progress ${hours.toFixed(1)}/5.0h`
    ]
    rcon.warn(eos_id, lines.join('\n\n'))
    INSERT INTO squadjs_sl_warn_log (match_id, leader_player_id, warned_at)
    VALUES (?, ?, NOW())
```

Helper:
```
rolling7dHours(player_id):
  return (SELECT COALESCE(SUM(qualifying_sl_s), 0)
          FROM squadjs_sl_round_stats
          WHERE player_id = ? AND created_at > NOW() - INTERVAL 7 DAY) / 3600
```

### 5.C Round-end aggregation (`ROUND_ENDED`)
```
on ROUND_ENDED(match):
  if match.duration_s < 1200: return     // <20 min, skip seeding/short rounds
  if match.end_reason indicates canceled/crashed: return  // if field exists

  // Per (player, squad) intermediates from this match's ticks
  perPlayerSquad = SELECT
      leader_player_id AS player_id,
      squad_id,
      COUNT(*) * 30 AS sl_seconds
    FROM squadjs_squad_ticks
    WHERE match_id = match.id AND leader_player_id IS NOT NULL
    GROUP BY leader_player_id, squad_id

  perSquadStrength = SELECT
      squad_id,
      SUM(CASE WHEN member_count >= 5 THEN 30 ELSE 0 END) AS strength_s
    FROM squadjs_squad_ticks
    WHERE match_id = match.id
    GROUP BY squad_id

  perPlayerSquadQualifying = SELECT
      leader_player_id AS player_id,
      squad_id,
      SUM(CASE WHEN member_count >= 5 THEN 30 ELSE 0 END) AS qualifying_s
    FROM squadjs_squad_ticks
    WHERE match_id = match.id AND leader_player_id IS NOT NULL
    GROUP BY leader_player_id, squad_id

  // Combine per player
  for each player_id with any rows:
    sl_tenure_s          = sum over squads of perPlayerSquad.sl_seconds
    max_squad_strength_s = max over squads of perSquadStrength.strength_s   // for display

    passed_y = any of player's squads has perSquadStrength.strength_s
                                          >= match.duration_s / 2
    passed_z = sl_tenure_s >= match.duration_s / 2

    qualifying_sl_s = sum over squads where perSquadStrength[squad_id].strength_s
                                          >= match.duration_s / 2
                      of perPlayerSquadQualifying[player_id, squad_id].qualifying_s
    if not passed_z: qualifying_sl_s = 0

    INSERT INTO squadjs_sl_round_stats
      (match_id, player_id, steam_id, round_duration_s,
       max_squad_strength_s, sl_tenure_s, qualifying_sl_s, passed_y, passed_z, created_at)
    VALUES (...)
    ON DUPLICATE KEY UPDATE
      max_squad_strength_s = VALUES(max_squad_strength_s),
      sl_tenure_s          = VALUES(sl_tenure_s),
      qualifying_sl_s      = VALUES(qualifying_sl_s),
      passed_y             = VALUES(passed_y),
      passed_z             = VALUES(passed_z)
```

Idempotent re-runs are safe via the unique `(match_id, player_id)` constraint and `ON DUPLICATE KEY UPDATE`.

### 5.D Reward grant cron (every 30 min)
```
candidates = SELECT player_id, steam_id, SUM(qualifying_sl_s) AS s
             FROM squadjs_sl_round_stats
             WHERE created_at > NOW() - INTERVAL 7 DAY
             GROUP BY player_id, steam_id
             HAVING s > 0

for each candidate:
  rolling_h = candidate.s / 3600

  current = SELECT * FROM WhitelistEntry
            WHERE steamId = candidate.steam_id
              AND server = 'main'
              AND (expiresAt IS NULL OR expiresAt > NOW())

  sl_entry    = first row with clanId = SL_CLAN_ID, or null
  other_entry = first row with clanId != SL_CLAN_ID, or null

  if rolling_h < 5.0: continue          // under threshold; let existing entry expire

  if other_entry is not null: continue  // paid/clan member; per 8c rule, skip

  if sl_entry is null:
    user = SELECT * FROM User WHERE steamId = candidate.steam_id
    INSERT INTO WhitelistEntry
      (steamId, server, clanId, userId, expiresAt, addedBy, reason)
    VALUES
      (candidate.steam_id, 'main', SL_CLAN_ID, user?.id, NOW() + INTERVAL 7 DAY,
       'sl-reward-system',
       'Earned via Squad Leader rewards (5h+ rolling 7d)')
    log(INFO, 'sl-grant', {steam_id, user_id: user?.id})
    if user?.discordId:
      try: DM(user.discordId, congratulations message)
      catch: log(WARN, 'sl-grant-dm-failed')
    continue

  // sl_entry exists
  if sl_entry.expiresAt < NOW() + INTERVAL 24 HOUR:
    UPDATE WhitelistEntry
      SET expiresAt = expiresAt + INTERVAL 7 DAY
      WHERE id = sl_entry.id
    log(INFO, 'sl-extend', {steam_id, entry_id: sl_entry.id})
    // no DM on silent renewal
```

Dry-run: when `SL_REWARD_DRY_RUN=true`, log the same lines but skip all `INSERT` / `UPDATE` / `DM` calls.

### 5.E Leaderboard render (every 3 h)
```
rows = SELECT
         p.id AS player_id,
         p.steam_id,
         p.last_name,
         SUM(s.qualifying_sl_s)/3600.0 AS hours
       FROM squadjs_players p
       JOIN squadjs_sl_round_stats s ON s.player_id = p.id
       WHERE s.created_at > NOW() - INTERVAL 7 DAY
       GROUP BY p.id
       HAVING hours > 0
       ORDER BY hours DESC
       LIMIT 20

for each row:
  user = SELECT discordName FROM User WHERE steamId = row.steam_id
  row.display_name = user?.discordName ?? row.last_name

  active = SELECT clanId FROM WhitelistEntry
           WHERE steamId = row.steam_id AND server = 'main'
             AND (expiresAt IS NULL OR expiresAt > NOW())
  row.badge =
    has clanId = SL_CLAN_ID -> '✓ SL'
    else has any           -> '✓'
    else                   -> '—'

embed = build embed
  title:       'Squad Leader Rankings (rolling 7 days)'
  description: 'Top 20 SLs by qualifying SL time. SL ≥5h → 7 days free whitelist.'
  body:        code block, fixed-width table of rank / name / hours / badge
  footer:      'Updated every 3 hours · Next update <t:UNIX:R>'

msgRef = botState.get('sl_leaderboard_message')
if msgRef:
  try: channel.messages.fetch(msgRef.message_id).then(m => m.edit({embeds: [embed]}))
  catch (404): msgRef = null
if not msgRef:
  msg = channel.send({embeds: [embed]})
  botState.set('sl_leaderboard_message', {channel_id: channel.id, message_id: msg.id})
```

## 6. Data model

### 6.1 New SquadJS tables (MariaDB on prod/staging containers)

#### `squadjs_squad_ticks`
| column | type | notes |
|---|---|---|
| `id` | `BIGINT` PK auto | |
| `server_id` | `INT` | FK `squadjs_servers.id` |
| `match_id` | `BIGINT` | FK `squadjs_matches.id`, NULL if between rounds |
| `tick_at` | `DATETIME(3)` | poll timestamp |
| `team_id` | `TINYINT` | 1 or 2 |
| `squad_id` | `INT` | in-game squad ID (resets each match) |
| `squad_name` | `VARCHAR(255)` | |
| `leader_player_id` | `BIGINT` NULL | FK `squadjs_players.id` |
| `member_count` | `SMALLINT` | |

Indexes: `(match_id, squad_id, tick_at)`, `(leader_player_id, tick_at)`, `(server_id, tick_at)`.

Retention: **60 days**, daily prune.

#### `squadjs_sl_round_stats`
| column | type | notes |
|---|---|---|
| `id` | `BIGINT` PK auto | |
| `match_id` | `BIGINT` | indexed |
| `player_id` | `BIGINT` | indexed |
| `steam_id` | `VARCHAR(20)` | denormalized for fast joins |
| `round_duration_s` | `INT` | |
| `max_squad_strength_s` | `INT` | max strength_s across this player's squads (display only) |
| `sl_tenure_s` | `INT` | summed across squads |
| `qualifying_sl_s` | `INT` | 0 if Y or Z failed |
| `passed_y` | `TINYINT(1)` | |
| `passed_z` | `TINYINT(1)` | |
| `created_at` | `DATETIME` | |

Unique: `(match_id, player_id)`. Index: `(player_id, created_at)`. **No retention.**

#### `squadjs_sl_warn_log`
| column | type | notes |
|---|---|---|
| `match_id` | `BIGINT` | |
| `leader_player_id` | `BIGINT` | |
| `warned_at` | `DATETIME` | |

PK: `(match_id, leader_player_id)`. Retention: **60 days**, daily prune.

### 6.2 Bot state persistence
Either a `BotState` table in `royal_battalion_prod` (one row, `key`/`value`/`updatedAt`) OR a JSON file at `<bot>/data/bot-state.json`. Implementation-time decision based on whether a settings table already exists. Default to JSON file if no existing pattern.

### 6.3 No changes to existing tables
- `WhitelistEntry` already has `steamId`, `clanId`, `userId`, `expiresAt`, `addedBy`, `reason`.
- `User` already has `discordId`, `steamId`.
- The existing `Clan` row for SL whitelist exists (id `cmq8eaiat03ym01qtcdgs7bri`).
- `userService.linkSteamId()` gains an `allowOverwrite` parameter (default `false` to preserve existing prospect-flow semantics).

## 7. Configuration & secrets

Bot (env vars):
- `SL_LEADERBOARD_CHANNEL_ID` — required.
- `SL_REWARD_DRY_RUN` — optional, default `false`.
- `SL_REWARD_CRON_INTERVAL_MS` — optional, default `1800000` (30 min).
- `SL_LEADERBOARD_CRON_INTERVAL_MS` — optional, default `10800000` (3 h).

SquadJS plugin options (config.json):
- `database` — Sequelize connector for SquadJS DB (existing pattern, same as welcome plugin).
- `webpageDatabase` — Sequelize connector for the webpage DB (new). Read-only credentials preferred.
- `pollIntervalMs` — default `30000`.
- `pruneIntervalMs` — default `86400000` (24 h).

## 8. Error handling

| Failure | Behavior |
|---|---|
| `ListSquads` RCON timeout / parse error | Log warn, skip tick. |
| DB insert into `squadjs_squad_ticks` fails | Log error, skip tick. One missing tick = 30 s of lost resolution; acceptable. |
| Webpage DB unreachable for warn-eligibility | Skip the warn (fail-closed). Log error. |
| RCON `AdminWarn` fails | Log; do NOT insert into `squadjs_sl_warn_log` so retry happens next tick. |
| `ROUND_ENDED` aggregation crashes mid-execution | Re-runnable. Aggregation uses `ON DUPLICATE KEY UPDATE` keyed on `(match_id, player_id)`. |
| Grant cron DB write fails | Log; notify `#bot-logs` channel. Idempotent — next run will retry. |
| Discord DM to player fails | Log and continue. Do not block the grant. |
| Leaderboard message ID is stale (deleted) | Edit attempt 404s; bot falls back to posting new message and persists new ID. |
| Leaderboard channel deleted / lost perms | Log error each cycle. Do not crash. |

## 9. Observability

- `Logger.verbose('SLTracking', level, …)` for the SquadJS plugin (matches existing convention).
- Bot logs via Pino at `info` for grants/extensions, `warn` for skipped DMs, `error` for DB failures.
- INFO-level metrics per cycle:
  - **Per-poll:** `ticks_inserted`, `transitions_detected`, `warns_sent`, `warns_skipped_ineligible`, `warns_skipped_already_warned`.
  - **Per-round-end:** `players_aggregated`, `players_passed_yz`.
  - **Per-grant-cron:** `candidates`, `grants`, `extensions`, `skips_other_whitelist`, `skips_under_threshold`.
  - **Per-leaderboard-cycle:** `rows_returned`, `outcome` (`edited` / `posted_new` / `failed`).
- No Grafana dashboards in MVP; flag as a follow-up.

## 10. Testing strategy

No automated test suite exists in either SquadJS or the bot.

| Component | Strategy |
|---|---|
| Y+Z math + qualifying-seconds computation | Extract into a pure function. Vitest in the bot OR a one-off Node script in SquadJS. Synthetic tick arrays cover: short rounds, mid-round SL handoff, briefly-full squad, fully qualifying round. |
| `sl-tracking` plugin polling | Deploy to staging. Verify rows in `squadjs_squad_ticks` during real play. |
| Round-end aggregation | Hand-spot-check 2–3 players against the staging scoreboard after a real round. Smoke-test SQL committed to spec (§12). |
| Warn-eligibility logic | Unit test with 4 cases: no whitelist / SL-only / non-SL only / both. |
| Grant cron | Run with `SL_REWARD_DRY_RUN=true` on prod data for 1 week before flipping live. |
| Leaderboard embed | On staging, set cadence to 5 min. Verify edits and new-message fallback (manually delete the message). |
| DM SteamID button | Manual: trigger DM, click button, submit valid + invalid Steam64, verify website row. |

## 11. Rollout plan

1. **Phase 1.** Ship `sl-tracking` plugin to staging in read-only mode (polling + aggregation only; no warns, no grants). Observe data for 1 week.
2. **Phase 2.** Enable in-game warn on staging. Verify cadence isn't spammy.
3. **Phase 3.** Enable grant cron on staging in dry-run mode for 1 week. Inspect logs.
4. **Phase 4.** Flip grant cron live on staging. Enable leaderboard embed. Observe for 1 week.
5. **Phase 5.** Promote to production with all flags on.

DM SteamID button is independent — can ship any time after Phase 1.

## 12. Smoke-test queries

After each phase, run on the staging DB:

```sql
-- Tick rate sanity: should be roughly poll_interval × active squads × match length
SELECT match_id, COUNT(*) AS ticks, COUNT(DISTINCT squad_id) AS squads
FROM squadjs_squad_ticks
WHERE tick_at > NOW() - INTERVAL 1 DAY
GROUP BY match_id
ORDER BY match_id DESC LIMIT 5;

-- Per-match SL stats sanity
SELECT player_id, steam_id, sl_tenure_s, max_squad_strength_s, qualifying_sl_s, passed_y, passed_z
FROM squadjs_sl_round_stats
WHERE created_at > NOW() - INTERVAL 1 DAY
ORDER BY qualifying_sl_s DESC LIMIT 20;

-- Rolling 7-day standings (what the leaderboard reads)
SELECT p.last_name, ROUND(SUM(s.qualifying_sl_s)/3600, 2) AS h
FROM squadjs_players p
JOIN squadjs_sl_round_stats s ON s.player_id = p.id
WHERE s.created_at > NOW() - INTERVAL 7 DAY
GROUP BY p.id
HAVING h > 0
ORDER BY h DESC LIMIT 20;

-- Grants applied
SELECT steamId, expiresAt, reason, addedBy, createdAt
FROM WhitelistEntry
WHERE clanId = 'cmq8eaiat03ym01qtcdgs7bri'
ORDER BY createdAt DESC LIMIT 20;
```

## 13. Open implementation-time decisions

These are intentionally deferred from design to implementation; they don't affect approval.

- Bot state storage: `BotState` table vs. `data/bot-state.json` file. Decide after checking if the bot already has a settings table.
- Whether `squadjs_matches` exposes an "end reason" field (used to skip canceled rounds). If absent, ship without that filter — `round_duration_s < 1200` already catches most pathological cases.
- Exact RCON-line format from `ListSquads` for the parser. Reuse any existing parser in the SquadJS codebase if available.

## 14. Anti-abuse residuals

This design closes the obvious "claim SL in a friend-stacked squad" abuse via Y+Z+per-tick filters, but does not close every gap:

- **AFK-friends pattern.** 5 friends sitting in main for 30 minutes with one "SL" passes all gates. Not addressed in MVP. If observed in practice, add a `squadjs_combat_events`-based filter in V2: squad must record ≥N combat events (any of kill/death/revive with `attacker_squad_id` or `victim_squad_id`) during the qualifying portion. Cheap query.
- **Last-window grind on rolling C-cadence.** Rolling-window mechanics inherently encourage end-of-window pushes. Not addressed — this is how rolling windows work.
- **Perpetual whitelist for top SLs.** Intentional (per Q8a-i: no cooldown).
