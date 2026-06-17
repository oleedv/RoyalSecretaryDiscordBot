# Seed Progression Embed Redesign

**Date:** 2026-06-17
**Status:** Design — pending implementation plan
**Area:** Discord bot — `src/services/seedTracker/`

## Goal

Refresh the **public** seed-progression embed so progress reads at a glance, surface a
clear "act now" deadline derived from the rolling window, personalise it with the player's
Steam avatar, and hide the unpolished "quality" metric from public view.

## Background

Players earn a 30-day whitelist by seeding on `required_seed_days` distinct days
(default 10) within a rolling `rolling_window_days` window (default 30). The count is a
`COUNT(DISTINCT seed_date)` over `seed_date >= CURDATE() - INTERVAL <window> DAY`
(`seedTrackerService.js:getPlayerSeedStats`). It is a **rolling window**, not a fixed
reset: each seed day counts for exactly `window` days from the day it was earned, then
drops off individually. There is no single date on which progress resets to zero.

Surfaces in scope:

- `buildProgressionEmbed` — **public**, posted to `progression_channel_id` after a seed
  session completes (when not yet whitelisted). Currently shows a `[####----] X/Y days`
  bar, Streak, **Quality**, Steam ID.
- `buildLeaderboardEmbed` — **public**, monthly leaderboard. Currently shows **Quality**
  per seeder.

Out of scope (see below): `buildDmProgressionEmbed`. Its handler (`handleSeedProgression`,
customId `seed_progression`) is registered in the interaction router but **no button or
command anywhere produces that customId** — the embed is currently unreachable. It is left
untouched (so it keeps using `buildProgressBar`).

## Decisions

1. **Progress visual: milestone track (public embed only).** Add a node track, one node
   per required day, connected by `━`, with the halfway and goal days marked as distinct
   checkpoints (these already exist as real milestones — `buildMilestoneEmbed` fires
   "Halfway There!" at 5 and "Goal Reached!" at 10). The old `buildProgressBar` is **kept**
   (still used by the untouched DM embed); `buildMilestoneTrack` is added alongside it.
2. **No legend / caption.** The track is followed only by a bold `X / Y days` count. No
   `◆ halfway · ◎ goal` legend and no "N to go" line — the filled nodes and the count carry
   the meaning without explanation.
3. **Hide quality on public surfaces.** Remove the Quality field from `buildProgressionEmbed`
   and the `| Quality: X` segment from `buildLeaderboardEmbed`.
4. **Rolling-window deadline, action-framed.** Add a `Seed again by` field with a Discord
   relative timestamp pointing at when the player's oldest counted day drops off. The action
   verb + deadline makes the rolling behaviour self-evident — no explanatory copy.
5. **Steam avatar personalisation.** Set the player's Steam `avatarfull` as the embed
   thumbnail on the public progression embed. Graceful fallback to no thumbnail when the
   Steam API key is unset, the profile is private, or the fetch fails.

## Milestone track renderer

`buildMilestoneTrack(done, total)` returns **only** the node-track string — no count and no
legend. The embed renders it in backticks with a bold day count beneath:

```
`●━●━●━●━◆━○━○━○━○━◎`
**5 / 10 days**
```

Symbols (pure text, monospace-safe — rendered inside a code block so connectors align; no
emoji inside the block):

| Symbol | Meaning |
|---|---|
| `●` | completed day |
| `○` | remaining day |
| `◆` / `◇` | halfway checkpoint, filled once reached |
| `◉` / `◎` | goal checkpoint, filled once reached |

- `done` is clamped to `[0, total]`.
- Halfway node index = `floor(total / 2)` (1-based). Goal node = `total` (last).
- Each node is followed by `━` except the last.

Rendered tracks (`total = 10`):

```
5 / 10   ●━●━●━●━◆━○━○━○━○━◎
1 / 10   ●━○━○━○━◇━○━○━○━○━◎
10 / 10  ●━●━●━●━◆━●━●━●━●━◉   (grant embed fires here; shown for reference)
```

## Rolling-window deadline

- Add `MIN(s.seed_date) AS firstSeedDate` to the `getPlayerSeedStats` query and return it.
- `seedAgainBy = firstSeedDate + rolling_window_days days`. This is when the oldest counted
  day leaves the window (and the count ticks down by one). Day precision is sufficient;
  rendering nudges the player slightly early, which is the safe direction.
- Rendered as a Discord relative timestamp `<t:UNIX:R>` in a `Seed again by` field.
- Omitted entirely when `uniqueDays === 0` (no day to expire).

## Steam avatar (cached)

The avatar URL is fully reconstructable from the Steam `avatarhash`, so the cache stores
**only the hash + steam id** (not the URL). DB-backed (not an in-memory map), consistent
with the project's "prefer DB for state between interactions" rule.

### Table (`Royal_secretary`, created in `schema.js`)

```sql
CREATE TABLE IF NOT EXISTS steam_avatar_cache (
  steam_id        VARCHAR(20) NOT NULL PRIMARY KEY,
  avatar_hash     CHAR(40)    NOT NULL,
  first_cached_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_checked_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
)
```

`last_checked_at` ("last cache time") is set **explicitly** on every refresh — deliberately
NOT `ON UPDATE CURRENT_TIMESTAMP`, because when the hash is unchanged the row update is a
no-op and the timestamp would never re-bump, pinning the entry "stale" forever and forcing
an API call every time.

### URL reconstruction

```
buildAvatarUrl(hash) -> `https://avatars.steamstatic.com/${hash}_full.jpg`
```

Host and `_full.jpg` are constants. (Risk: if Steam changes the CDN host this one constant
must be updated — acceptable, since storing only the hash is the explicit goal. `_medium` /
bare `.jpg` variants are available from the same hash if a smaller size is ever wanted.)

### Lookup flow — `steamService.getAvatarUrl(steamId)` → string | null

1. Read the cache row. If present and `now - last_checked_at < AVATAR_REFRESH_DAYS`, return
   `buildAvatarUrl(cached.avatar_hash)` — **no API call**.
2. Otherwise (missing or stale) call `getSteamProfile`. On success, upsert and return the URL.
3. If the API call fails but a (stale) cached hash exists, return it anyway — a slightly old
   avatar beats none.
4. Only return `null` when there is no cache and the API yields nothing (or no key — the
   existing `isConfigured()` guard).

`AVATAR_REFRESH_DAYS = 30` (constant in `steamService.js`; avatars change rarely — lower to
10 for fresher).

Upsert (`first_cached_at` preserved on update by omitting it):

```sql
INSERT INTO steam_avatar_cache (steam_id, avatar_hash) VALUES (?, ?)
ON DUPLICATE KEY UPDATE avatar_hash = VALUES(avatar_hash), last_checked_at = NOW()
```

## Embed previews by stage (public progression embed)

Boxes are schematic (Discord renders no borders); they convey layout, the milestone track,
and field placement. `[avatar]` marks the thumbnail (top-right). Relative timestamps
(`in N days`) are illustrative — the real value is `oldest day + window`.

Posted after a seed session completes, so it starts at `1 / 10`. At `10 / 10` the
whitelist-grant embed fires instead, so the public post tops out around `9 / 10`.

```
Stage 1 / 10  — first seed day logged
┌─ Seed Progress ──────────────────────────[avatar]─┐
│ Jonas                                              │
│ `●━○━○━○━◇━○━○━○━○━◎`                              │
│ 1 / 10 days                                        │
│                                                    │
│ Streak                 Seed again by               │
│ 1 day                  in 29 days                  │
│                                                    │
│ Steam ID                                           │
│ 76561198XXXXXXXXX                                  │
└────────────────────────────────────────────────────┘

Stage 5 / 10  — halfway reached (◆ now filled)
┌─ Seed Progress ──────────────────────────[avatar]─┐
│ Jonas                                              │
│ `●━●━●━●━◆━○━○━○━○━◎`                              │
│ 5 / 10 days                                        │
│                                                    │
│ Streak                 Seed again by               │
│ 3 days                 in 12 days                  │
│                                                    │
│ Steam ID                                           │
│ 76561198XXXXXXXXX                                  │
└────────────────────────────────────────────────────┘

Stage 9 / 10  — one to go (deadline tightening)
┌─ Seed Progress ──────────────────────────[avatar]─┐
│ Jonas                                              │
│ `●━●━●━●━◆━●━●━●━●━◎`                              │
│ 9 / 10 days                                        │
│                                                    │
│ Streak                 Seed again by               │
│ 8 days                 in 5 days                   │
│                                                    │
│ Steam ID                                           │
│ 76561198XXXXXXXXX                                  │
└────────────────────────────────────────────────────┘
```

## Component changes

### `src/database/schema.js`
- Add the `steam_avatar_cache` `CREATE TABLE IF NOT EXISTS` (idempotent, alongside the
  existing table definitions; secretary/`Royal_secretary` pool).

### `src/services/steamService.js`
- `getSteamProfile`: add `avatarHash: player.avatarhash || null` to the returned object.
- Add `AVATAR_REFRESH_DAYS`, `buildAvatarUrl(hash)`, and the cache-aware
  `getAvatarUrl(steamId)` orchestrator, plus small `getCachedAvatar` / `upsertCachedAvatar`
  DB helpers (secretary pool).

### `src/services/seedTracker/seedTrackerService.js`
- `getPlayerSeedStats`: add `MIN(s.seed_date) AS firstSeedDate`; return `firstSeedDate`
  (additive — existing callers unaffected).
- `processCompletedSession`: resolve `avatarUrl` via `getAvatarUrl(data.steamID)`
  (cache-aware, best-effort); compute `seedAgainBy` from `stats.firstSeedDate + windowDays`;
  pass both into `buildProgressionEmbed`.

### `src/services/seedTracker/seedTrackerEmbeds.js`
- **Add** `buildMilestoneTrack(done, total)`; keep `buildProgressBar` (DM embed still uses it).
- `buildProgressionEmbed`: switch to an options object
  `{ name, steamId, uniqueDays, required, streak, avatarUrl, seedAgainBy }`; render the
  milestone track + bold `X / Y days` count (no legend); **remove the Quality field**; add
  the `Seed again by` field (when set); `.setThumbnail(avatarUrl)` when present.
- `buildLeaderboardEmbed`: drop the `| Quality: ${quality}` segment from each line.
- `buildDmProgressionEmbed`: **unchanged** (out of scope).
- Keep `formatQuality` (still used by the DM embed).

### Unchanged
- `src/handlers/seedTrackerButtons.js` and the `seed_progression` handler — left as-is.

## Testing

- Unit-test `buildMilestoneTrack`: `done = 0`, partial, exactly halfway, `done = total`,
  `done > total` (clamp), and a non-default `total` (e.g. 7) to verify the halfway index.
- Assert the public progression embed has **no** Quality field and **does** have the
  milestone track + day count.
- Assert `Seed again by` is present when `seedAgainBy` is set and absent at `uniqueDays = 0`.
- Assert the thumbnail is set when `avatarUrl` is provided and omitted when null.
- Assert `buildLeaderboardEmbed` lines no longer contain `Quality:`.
- Avatar cache: cold miss → API called + row upserted; fresh hit → **no** API call; stale
  entry → API called + row refreshed (`first_cached_at` preserved); API failure with a stale
  row → returns the stale URL; no cache + API null → `null`.
- `buildAvatarUrl(hash)` → `https://avatars.steamstatic.com/<hash>_full.jpg`.

## Out of scope

- **DM / ephemeral progression embed** (`buildDmProgressionEmbed` + `handleSeedProgression`):
  currently unreachable (no button/command emits its customId). Left untouched; wiring it up
  is a possible follow-up.
- **Website** seeding pages (separate repo) — quality hiding there is a possible follow-up.
- Changing the rolling-window mechanic itself; only its presentation changes.
