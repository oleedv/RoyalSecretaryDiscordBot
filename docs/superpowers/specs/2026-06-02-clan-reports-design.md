# Clan Reports — Design Spec

**Date:** 2026-06-02
**Project:** RoyalSecretaryDiscordBot
**Author:** brainstormed with claude-opus-4-7

## Overview

Interactive slash command `/clanreport` for the Royal Secretary Discord bot. Replaces the legacy Python bot's `/wl activity` and `/wl clans` commands with a single multi-panel reports surface. Output is a downloadable `.txt` file with a metadata header; the in-channel picker is a transient setup wizard that gets edited into the artifact on generation.

## Goals

- Reach Python-bot parity for activity and whitelist roster reports.
- Add six new panels (Overview, Seeding, Combat, Match outcomes, Heatmap, Growth) drawing on SquadJS data the Python bot didn't exploit.
- Use the webpage's canonical `Clan` table as the source of truth.
- Single `.txt` artifact per report, self-contained with a metadata header for archival.

## Non-goals (v1)

- Multi-clan comparison views.
- Real-time or streaming updates.
- Per-server moderation reports (no moderation table exists).
- Rich Discord embeds for report bodies (deliberately swapped for `.txt`).

## Source of truth

### Clans

`Clan` table in the `Royal_secretary` MariaDB, managed by the webpage's Prisma schema (`prisma/schema.prisma:82-88`).

| Column | Type | Notes |
|---|---|---|
| `id` | String (cuid) | PK |
| `name` | String | Unique full name, e.g. "Royal Battalion" |
| `tag` | String | Unique short tag, e.g. "RB" |
| `createdAt` | DateTime | |

Managed via the webpage admin dashboard; the bot is read-only.

### Members

`WhitelistEntry` table (`prisma/schema.prisma:90-116`). Active members for a clan:

```sql
SELECT * FROM WhitelistEntry
WHERE clanId = ?
  AND (expiresAt IS NULL OR expiresAt > NOW());
```

### Game data

`squadjs_*` tables on a separate `squadjs` MariaDB pool. Cross-database joins are not possible. Pattern: fetch `steamId` list from `WhitelistEntry`, then run SquadJS queries with `WHERE p.steam_id IN (?)`. Discord clans realistically hold <=200 members, so an inline `IN` clause is fine.

### Tag spotters

`squadjs_players.prefix` is auto-parsed from in-game names (see `SquadJS-Royal-battalion/squad-server/utils/clan-tag-parser.js`). The parser strips brackets, so `prefix = 'RB'` for `[RB] Player`. Tag spotters = players whose `prefix` matches the clan's `tag` but whose `steam_id` is not on the whitelist.

## UX flow

1. Staff member runs `/clanreport` in any channel they have permission to use. The bot replies publicly with the picker embed.
2. Picker embed contains a clan dropdown (StringSelectMenu, alphabetical by name) and a server dropdown (StringSelectMenu, from `squadjs_servers`).
3. After both dropdowns have a selection, the embed re-renders with:
   - Time-window row: `[7d] [30d] [90d] [Inf]`; `30d` highlighted (`ButtonStyle.Primary`).
   - Panel row 1 (emoji-only): Overview, Activity, Seeding, Roster, Combat.
   - Panel row 2 (emoji + 1-word label): Matches, Heatmap, Growth.
   - Legend in the embed body explaining each emoji.
4. Clicking a window button re-renders the embed with the new window highlighted. No DB call.
5. Clicking a panel button runs the queries, formats the `.txt`, and edits the message in-place: removes embed + components, sets `content` to a short summary line, attaches the `.txt`. Same message id.

### Permissions

Staff-only. Gate inside `execute()` via the bot's existing `requireRole(interaction, staffRoles())` helper. `staffRoles = config.prospects?.roles || []` matches the `/activity` command's pattern (`src/commands/activity.js:12-37`).

### Time windows

| Label | Token | SQL predicate |
|---|---|---|
| 7d | `7` | `AND c.time >= DATE_SUB(NOW(), INTERVAL 7 DAY)` |
| 30d (default) | `30` | `AND c.time >= DATE_SUB(NOW(), INTERVAL 30 DAY)` |
| 90d | `90` | `AND c.time >= DATE_SUB(NOW(), INTERVAL 90 DAY)` |
| Inf | `all` | (predicate omitted) |

The Roster panel ignores the window (always current whitelist state). The Growth panel applies the window to new/expired entries; "inactive >30d" is a fixed 30-day threshold regardless of the chosen window.

### Discord button emoji mapping

The implementer should use the literal Unicode glyph in `.setEmoji()`; codepoints listed here for unambiguity. No emoji glyphs are rendered in this spec.

| Panel | Codepoint | Common name | Row | Label shown? |
|---|---|---|---|---|
| Overview | U+1F4CA | bar chart | top | no |
| Activity | U+23F1, U+FE0F | stopwatch | top | no |
| Seeding | U+1F331 | seedling | top | no |
| Roster | U+1F465 | busts in silhouette | top | no |
| Combat | U+2694, U+FE0F | crossed swords | top | no |
| Matches | U+1F3C6 | trophy | bottom | yes ("Matches") |
| Heatmap | U+1F550 | clock face one oclock | bottom | yes ("Heatmap") |
| Growth | U+1F4C8 | chart with upwards trend | bottom | yes ("Growth") |

### customId encoding (stateless — Approach A)

| customId | Use | Encoding |
|---|---|---|
| `cr_clan_select` | Clan dropdown | StringSelectMenu; the selected `Clan.id` arrives in `interaction.values[0]` |
| `cr_server_select` | Server dropdown | StringSelectMenu; the selected `squadjs_servers.id` arrives in `interaction.values[0]` |
| `cr_window:<clanId>:<serverId>:<window>` | Window button | re-renders picker with new window highlighted |
| `cr_panel:<panel>:<clanId>:<serverId>:<window>` | Panel button | generates `.txt`, replaces message in place |

Worst-case length: `cr_panel:matches:<25-char cuid>:<3>:<3>` ≈ 47 chars — well under Discord's 100-char limit.

### Picker re-render strategy

When one dropdown fires, the handler needs the *other* dropdown's current selection to decide whether the button rows should appear. Mechanism:

1. Every time `pickerEmbed.build(state)` re-renders the components, it calls `.setDefaultValues([{ id: state.clanId, type: 'role' }])` (or the equivalent for StringSelectMenu — use the discord.js v14 API for the menu type) on whichever dropdown already has a known value. This causes Discord to ship that value back in `interaction.message.components` on subsequent interactions.
2. When a dropdown fires, the handler reads its own value from `interaction.values[0]` and the other dropdown's value by walking `interaction.message.components` and inspecting the relevant select's `data.default_values` (or the equivalent v14 accessor).
3. The handler builds a fresh `state = { clanId, serverId, window }` and calls `pickerEmbed.build(state)` which renders the full picker.

Until both dropdowns have a known value, the time-window row and panel rows are *omitted*. Once both are set, the full layout renders with the current window highlighted.

**Implementation verification gate:** the discord.js v14 mechanism for reading the previously-selected value of a StringSelectMenu from a message object should be confirmed during implementation. If `.setDefaultValues()` does not round-trip cleanly for StringSelectMenu (it works for role/user/channel selects, less commonly used for string selects), fall back to encoding the dropdown selections into the customId of the *other* dropdown on each re-render. The state is small (clanId + serverId) and fits well within the 100-char budget.

## File layout

```
RoyalSecretaryDiscordBot/src/
  commands/
    clanreport.js              # slash command entry + permission gate
  handlers/
    clanReportSelects.js       # handleClanSelect, handleServerSelect
    clanReportButtons.js       # handleWindowSwitch, handleGenerate
  services/clanReports/
    clanReportService.js       # orchestrator: (clanId, serverId, window, panel) -> { content, file }
    clanReportQueries.js       # all SQL helpers (one per panel + shared KPI + tag spotters)
    clanReportFormatters.js    # plain-text formatters (one per panel + KPI block + metadata header)
    panelRegistry.js           # ordered array: id, codepoint, label, row, queryFn, formatFn
    pickerEmbed.js             # build picker embed + components for any (clanId, serverId, window) state
```

### Routing hookup

In `src/events/interactionCreate.js`, register:

```js
// Exact-match handlers (select menus)
buttonHandlers['cr_clan_select']   = clanReportSelects.handleClanSelect;
buttonHandlers['cr_server_select'] = clanReportSelects.handleServerSelect;

// Prefix-match handlers (buttons)
// (uses the existing startsWith routing pattern at interactionCreate.js:183-197)
buttonHandlers['cr_window:*'] = clanReportButtons.handleWindowSwitch;
buttonHandlers['cr_panel:*']  = clanReportButtons.handleGenerate;
```

If the existing `buttonHandlers` map already routes StringSelectMenu interactions (since they share the `interactionCreate` event), reuse it. Otherwise add a separate `selectHandlers` map keyed by `customId`. Verify during implementation.

### `panelRegistry.js`

Single source of truth for every panel. Adding a 9th panel later is a one-diff change in this file.

```js
export const PANELS = [
  { id: 'overview', emoji: 'U+1F4CA',          label: 'Overview', row: 'top',    query: getOverviewData,  format: formatOverview },
  { id: 'activity', emoji: 'U+23F1 U+FE0F',    label: 'Activity', row: 'top',    query: getActivityRows,  format: formatActivity },
  { id: 'seeding',  emoji: 'U+1F331',          label: 'Seeding',  row: 'top',    query: getSeedingRows,   format: formatSeeding },
  { id: 'roster',   emoji: 'U+1F465',          label: 'Roster',   row: 'top',    query: getRosterRows,    format: formatRoster },
  { id: 'combat',   emoji: 'U+2694 U+FE0F',    label: 'Combat',   row: 'top',    query: getCombatRows,    format: formatCombat },
  { id: 'matches',  emoji: 'U+1F3C6',          label: 'Matches',  row: 'bottom', query: getMatchOutcomes, format: formatMatches },
  { id: 'heatmap',  emoji: 'U+1F550',          label: 'Heatmap',  row: 'bottom', query: getHourBuckets,   format: formatHeatmap },
  { id: 'growth',   emoji: 'U+1F4C8',          label: 'Growth',   row: 'bottom', query: getGrowthRows,    format: formatGrowth },
];
```

Substitute the literal glyph for `emoji` at implementation time. The implementation must call `.setEmoji({ name: '<literal>' })` or pass the codepoint directly per discord.js v14 conventions. For `row: 'top'` render with `.setEmoji()` only; for `row: 'bottom'` render with `.setEmoji()` and `.setLabel(label)`.

## SQL queries

All queries use the bot's existing `query(sql, params, pool)` helper from `src/database/connection.js`. Pool names: `'secretary'` (default, for `Clan` and `WhitelistEntry`) and `'squadjs'` (game data).

Parameters are always parameterized. `IN (?)` is expanded by the mariadb driver when an array is bound.

### Shared: KPI summary

Inputs: `steamIds[], serverId, days|null`.

Returns: `{ activeMembers, expiringSoon, hours, avgHours, seedHours, seedRatio, kills, deaths, kd, winPct, matchesPlayed, lastActivityAt, lastActivityName, tagSpottersCount }`.

Composed from the per-panel queries below (Activity for hours/seed, Combat for K/D, Matches for win rate, etc.) plus a quick `SELECT COUNT(*) ... WHERE expiresAt < NOW() + INTERVAL 14 DAY` against `WhitelistEntry` for `expiringSoon`. The tag-spotter count is a `SELECT COUNT(*)` on the tag-spotter query (see below).

### Activity panel

```sql
SELECT
  p.steam_id AS steamId,
  MAX(p.name) AS name,
  MAX(p.last_seen) AS lastSeen,
  SUM(COALESCE(c.session_duration, 0)) AS totalSeconds,
  SUM(COALESCE(c.seed_duration, 0))    AS seedSeconds,
  SUM(CASE WHEN c.seed_duration > 0 THEN 1 ELSE 0 END) AS seedSessions,
  COUNT(*) AS joinCount
FROM squadjs_players p
JOIN squadjs_connections c ON c.player_id = p.id
WHERE p.steam_id IN (?)
  AND c.server_id = ?
  AND c.event_type = 'leave'
  -- window predicate inserted here
GROUP BY p.steam_id
ORDER BY totalSeconds DESC;
```

### Seeding panel

```sql
SELECT
  p.steam_id AS steamId,
  MAX(p.name) AS name,
  COUNT(DISTINCT s.seed_date)                                  AS seedDays,
  SUM(s.duration_seconds)                                      AS seedSeconds,
  AVG(s.quality_score)                                         AS avgQuality,
  SUM(CASE WHEN s.threshold_reached THEN 1 ELSE 0 END)         AS thresholdSessions,
  MAX(s.seed_date)                                             AS lastSeedDate
FROM squadjs_players p
JOIN squadjs_seed_sessions s ON s.player_id = p.id
WHERE p.steam_id IN (?)
  AND s.server_id = ?
  AND s.status = 'completed'
  -- window predicate on s.seed_date
GROUP BY p.steam_id
ORDER BY seedDays DESC;
```

If `config.seedTracker?.requiredSeedDays` is configured, the formatter adds a "milestone watch" callout listing members within 2 days of that threshold.

### Roster panel (`Royal_secretary` only, window ignored)

```sql
SELECT id, steamId, name, role, expiresAt, createdAt
FROM WhitelistEntry
WHERE clanId = ?
  AND (expiresAt IS NULL OR expiresAt > NOW())
ORDER BY role, name;
```

### Combat panel

Three queries, merged in JS by `steamId`. K/D = `kills / Math.max(deaths, 1)`.

```sql
-- Kills, teamkills given, wounds (attacker side)
SELECT
  ap.steam_id AS steamId,
  SUM(CASE WHEN ce.event_type = 'death' AND ce.teamkill = false THEN 1 ELSE 0 END) AS kills,
  SUM(CASE WHEN ce.event_type = 'death' AND ce.teamkill = true  THEN 1 ELSE 0 END) AS teamkillsGiven,
  SUM(CASE WHEN ce.event_type = 'wound'                          THEN 1 ELSE 0 END) AS wounds
FROM squadjs_combat_events ce
JOIN squadjs_players ap ON ap.id = ce.attacker_id
WHERE ap.steam_id IN (?)
  AND ce.server_id = ?
  -- window predicate on ce.time
GROUP BY ap.steam_id;

-- Deaths and teamkills taken (victim side)
SELECT
  vp.steam_id AS steamId,
  SUM(CASE WHEN ce.teamkill = false THEN 1 ELSE 0 END) AS deaths,
  SUM(CASE WHEN ce.teamkill = true  THEN 1 ELSE 0 END) AS teamkillsTaken
FROM squadjs_combat_events ce
JOIN squadjs_players vp ON vp.id = ce.victim_id
WHERE vp.steam_id IN (?)
  AND ce.server_id = ?
  AND ce.event_type = 'death'
  -- window predicate
GROUP BY vp.steam_id;

-- Revives (reviver side)
SELECT rp.steam_id AS steamId, COUNT(*) AS revives
FROM squadjs_combat_events ce
JOIN squadjs_players rp ON rp.id = ce.reviver_id
WHERE rp.steam_id IN (?)
  AND ce.server_id = ?
  AND ce.event_type = 'revive'
  -- window predicate
GROUP BY rp.steam_id;
```

### Match outcomes panel

```sql
-- Per-member match participation & team split
SELECT
  p.steam_id AS steamId,
  MAX(p.name) AS name,
  COUNT(DISTINCT sb.match_id) AS matchesPlayed,
  SUM(CASE WHEN sb.team_id = 1 THEN 1 ELSE 0 END) AS teamACount,
  SUM(CASE WHEN sb.team_id = 2 THEN 1 ELSE 0 END) AS teamBCount
FROM squadjs_scoreboard sb
JOIN squadjs_players p ON p.id = sb.player_id
WHERE p.steam_id IN (?)
  AND sb.server_id = ?
  -- window predicate on sb.time
GROUP BY p.steam_id;

-- Match outcomes the clan participated in
SELECT m.id, m.layer, m.start_time, m.end_time, m.winner,
       GROUP_CONCAT(DISTINCT sb.team_id) AS clanTeamIds
FROM squadjs_matches m
JOIN squadjs_scoreboard sb ON sb.match_id = m.id
JOIN squadjs_players p ON p.id = sb.player_id
WHERE p.steam_id IN (?)
  AND m.server_id = ?
  AND m.end_time IS NOT NULL
  -- window predicate on m.end_time
GROUP BY m.id;
```

Win attribution: parse `m.winner` JSON to get the winning `team_id`. For each match, compute the clan's plurality team in JS from `clanTeamIds` (the SQL above returns it as a comma-joined string — re-run scoreboard counts in JS if needed for accuracy). The clan "wins" the match iff the plurality team equals the winning team. Matches where the clan was evenly split across both teams are **excluded** from the win-rate denominator entirely (preserves honesty over inflating either numerator or denominator). The excluded count is shown in the panel body as `Mixed-team matches (excluded): <n>`.

### Heatmap panel

```sql
-- Hour-of-day distribution
SELECT HOUR(c.time) AS hour, COUNT(*) AS sessions
FROM squadjs_connections c
JOIN squadjs_players p ON p.id = c.player_id
WHERE p.steam_id IN (?)
  AND c.server_id = ?
  AND c.event_type = 'join'
  -- window predicate
GROUP BY HOUR(c.time)
ORDER BY hour;

-- Day-of-week distribution
SELECT DAYOFWEEK(c.time) AS dow, COUNT(*) AS sessions
FROM squadjs_connections c
JOIN squadjs_players p ON p.id = c.player_id
WHERE p.steam_id IN (?)
  AND c.server_id = ?
  AND c.event_type = 'join'
  -- window predicate
GROUP BY DAYOFWEEK(c.time)
ORDER BY dow;
```

### Growth panel

```sql
-- New members in window
SELECT steamId, name, role, createdAt
FROM WhitelistEntry
WHERE clanId = ?
  AND createdAt >= DATE_SUB(NOW(), INTERVAL ? DAY)
ORDER BY createdAt DESC;

-- Expired or removed in window
SELECT steamId, name, role, expiresAt
FROM WhitelistEntry
WHERE clanId = ?
  AND expiresAt IS NOT NULL
  AND expiresAt < NOW()
  AND expiresAt >= DATE_SUB(NOW(), INTERVAL ? DAY)
ORDER BY expiresAt DESC;
```

"Inactive >30d": load active members, then look up `last_seen` from `squadjs_players` (in `squadjs` pool) by `steam_id`. Members whose `last_seen` is null or older than 30 days from now are listed. Fixed 30-day threshold, not bound to the chosen window.

### Tag spotters

```sql
SELECT p.steam_id AS steamId, p.name, p.last_seen
FROM squadjs_players p
WHERE p.prefix = ?                       -- the clan's tag (no brackets — parser strips them)
  AND p.last_seen >= DATE_SUB(NOW(), INTERVAL 30 DAY)
  AND p.steam_id NOT IN (?)              -- clan's whitelist steamIds
ORDER BY p.last_seen DESC;
```

If the whitelist is empty, the `NOT IN (?)` driver expansion may behave oddly; bind a sentinel value like `'0'` instead.

## `.txt` artifact format

### Metadata header (every report)

```
=========================================================
Royal Battalion - Clan Report
=========================================================
Report:        <Panel name>
Clan:          [<tag>] <name> (id: <clanId>)
Server:        <serverName> (id: <serverId>)
Time window:   Last <N> days (<startDate> to <endDate> UTC)   -- or "All time"
Generated:     <YYYY-MM-DD HH:MM:SS> UTC
Generated by:  @<discordUsername> (Discord ID: <discordUserId>)
Bot version:   <package.json version>
=========================================================
```

`Generated by` is the user who clicked the *panel button*, not necessarily the one who ran `/clanreport` (different staff may interact with the picker).

### Shared KPI block (follows metadata header in every report)

```
SUMMARY (last <N> days unless noted)
-----------------------------------------------------------
Whitelisted members:   <activeCount> active (<expiringSoon> expiring within 14d)
Hours played:          <totalHours> h  (avg <avgHours> h/member)
Seed hours:            <seedHours> h  (<seedRatioPct>% of total)
Combat:                Kills <kills> / Deaths <deaths> (K/D <kd>)
Match win rate:        <winPct>% over <matchesPlayed> matches w/ >=1 member
Last activity:         <lastSeen UTC> (<playerName>)
Tag spotters:          <count> in-game [<tag>] tags not whitelisted (last 30d)
```

### Panel bodies

**Overview** — KPI block + full tag-spotter list:

```
TAG SPOTTERS - <count> in-game [<tag>] wearers not whitelisted (last 30d)
-----------------------------------------------------------
Name                          | SteamID            | Last seen           | Hours <window>
PlayerOne                     | 76561198...        | 2026-06-01 18:43    | 12.5
...
```

**Activity** — Python-parity table:

```
ACTIVITY - sorted by hours descending
-----------------------------------------------------------
Name                | SteamID            | Last seen          | Hours  | Seed h | Seed# | Joins
PlayerA             | 76561198...        | 2026-06-02 14:02   |  87.4  |  31.2  |    14 |    47
...
-----------------------------------------------------------
TOTAL                                                          <sum>    <sum>    <sum>   <sum>
```

**Seeding** — sorted by seed days desc; milestone watch if configured:

```
SEEDING - sorted by unique seed days descending
-----------------------------------------------------------
Name           | Seed days | Seed hours | Avg quality | Threshold sessions | Last seed
...

MILESTONE WATCH (requiredSeedDays = <N>)
- <count> members between <N-2> and <N> seed days: <names>
```

**Roster** — sorted by role then name:

```
ROSTER - current whitelist (not affected by time window)
-----------------------------------------------------------
Role           | Name           | SteamID            | Added              | Expires            | Last seen
...
```

**Combat** — sorted by kills desc:

```
COMBAT - sorted by kills descending
-----------------------------------------------------------
Name           | Kills | Deaths | K/D  | TK Given | TK Taken | Revives | Wounds
...
-----------------------------------------------------------
TOTAL            <sum>   <sum>    <kd>    <sum>      <sum>      <sum>     <sum>
```

**Matches** — aggregate + top layers + per-member:

```
MATCH OUTCOMES
-----------------------------------------------------------
Matches played (>=1 clan member):  <n>
Wins:                              <w> (<pct>%)
Avg match length:                  <m>m
Faction preference:                Team A <pct>% / Team B <pct>%

TOP MAPS PLAYED
1. <layer> - <count> matches
2. ...

PER-MEMBER PARTICIPATION
Name           | Matches | Team A | Team B
...
```

**Heatmap** — two ASCII charts, bar length normalized to peak (target 30 chars wide):

```
HOUR-OF-DAY (UTC) - sessions started
-----------------------------------------------------------
00 |##                          (12)
01 |#                           (7)
...
19 |####################        (143)
20 |######################      (158)
21 |####################        (147)
...

DAY-OF-WEEK
-----------------------------------------------------------
Mon |###############       (87)
Tue |############          (72)
...
Sun |##################    (104)
```

**Growth** — three sections:

```
GROWTH & CHURN (window: last <N> days)
-----------------------------------------------------------

NEW MEMBERS (<count>)
Name           | Role           | Added              | SteamID
...

EXPIRED / REMOVED (<count>)
Name           | Role           | Expired            | SteamID
...

INACTIVE >30 DAYS (<count>)
Name           | Last seen          | Days inactive
...
```

### File naming

`{tag}_{panel}_{YYYYMMDD_HHMMSS}.txt` (UTC timestamp). Examples: `RB_overview_20260602_143218.txt`, `OF_combat_20260603_091205.txt`.

### File size

Largest plausible v1 report (Activity, 50 members, 30d): ~12 KB. Discord upload limit is 25 MB. No truncation logic needed.

## Error handling

| Condition | Behavior |
|---|---|
| `Clan` table empty | Picker embed shows "No clans configured" with link to webpage admin. Dropdowns omitted. |
| `squadjs_servers` table empty | Picker embed shows "No servers configured". Dropdowns omitted. |
| Clan deleted between picker and panel click | `handleGenerate` re-fetches the clan; if missing, ephemeral followup with error. Picker embed left intact. |
| Server deleted between picker and panel click | Same pattern. |
| Clan has zero whitelist members | Report generates anyway; KPI block shows zeros; each panel body shows "No members found." Tag-spotter section may still have entries. |
| No SquadJS data in the window | KPI block shows zeros; panel body shows "No game activity in window." |
| Non-staff user clicks a button on a stale message | `handleGenerate` re-checks role via `requireRole`; ephemeral error. |
| DB query error | Log via Pino child logger (`module: 'clanReports'`), ephemeral error followup, no crash. |
| Interaction token expires during picker (>15 min idle) | Discord's natural behavior. User sees "interaction failed"; they re-run `/clanreport`. No special handling. |

## Logging

Pino child logger throughout the feature: `const log = logger.child({ module: 'clanReports' });`.

Logged events:

- Command invocation: `log.info({ userId, channelId }, 'clanreport invoked')`.
- Picker re-render: `log.debug({ clanId, serverId, window }, 'picker rendered')`.
- Panel generation: `log.info({ userId, clanId, serverId, window, panel, durationMs, fileBytes }, 'report generated')`.
- DB errors: `log.error({ err, panel, query }, 'query failed')`.

## Testing

**Unit:**
- Each function in `clanReportQueries.js` exercised against a mocked `query()` (verify SQL fragments, parameter shape, window predicate inclusion/exclusion).
- Each formatter in `clanReportFormatters.js` snapshot-tested against fixtures in `__fixtures__/`. Fixtures cover: empty clan, single-member clan, 50-member clan, sparse-data clan.

**Integration (manual smoke test in dev guild):**
- Run `/clanreport`, pick a real clan and server, click each panel, verify `.txt` opens cleanly in a text editor.
- Verify the picker re-renders correctly when either dropdown is selected first.
- Verify window switching does not re-query.
- Verify panel generation deletes the embed and replaces the message in-place.

**Edge cases (manual):**
- Clan with 0 members → all panels render with empty bodies.
- Clan with 1 member → no aggregation weirdness.
- 90d window on a clan with sparse data → KPI block does not produce NaN.

## Open follow-ups (v2 and beyond)

- Multi-clan comparison (`/clancompare clan1 clan2`).
- Scheduled weekly reports posted to a staff channel.
- Sortable Combat/Activity tables via secondary buttons.
- Per-server moderation table (warnings, kicks, bans) for a Disciplinary panel.
- Continuous role tracking (`PLAYER_ROLE_CHANGED` event) for an SL-time leaderboard.

## Decisions log

| Question | Decision |
|---|---|
| Clan source | `Clan` table (webpage canonical) |
| Panels in v1 | All 8 |
| Permissions | Staff-only, public posting |
| Time windows | 7d / 30d / 90d / All-time toggle, default 30d |
| Server scope | Picker dropdown (StringSelectMenu) |
| Button layout | Hybrid: emoji-only top 5, emoji + label bottom 3 |
| Clan count assumption | <25 (single dropdown, no pagination) |
| Tag overlay | Yes — count in every KPI block, full list in Overview body |
| Rate limit | None |
| Heatmap | ASCII bars |
| Overview role | Keep + KPI headers in every panel |
| Picker visibility | Public, edits in-place into `.txt` artifact |
| State management | Stateless `customId` encoding (Approach A) |
