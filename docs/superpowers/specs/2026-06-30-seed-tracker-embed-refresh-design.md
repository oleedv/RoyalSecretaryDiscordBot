# Seed Tracker Embed Refresh

Date: 2026-06-30

## Goal

Polish three Seed Tracker embeds for visual consistency and richer info:

1. **Seed Progress** track — drop the special halfway/goal glyphs, use plain circles.
2. **Thanks for seeding!** — surface the seeder's streak and all-time seed total.
3. **Whitelist Expiring Soon** — full redesign to match the other embeds (steam
   avatar thumbnail + Discord relative timestamps + renewal progress track).

Plus a consistency follow-on: align the DM progression embed to the same track.

All changes are cosmetic / additive. No schema changes. One new read-only query.

## Files

- `src/services/seedTracker/seedTrackerEmbeds.js` — embed builders (primary).
- `src/services/seedTracker/seedTrackerService.js` — new query + thanks call site.
- `src/services/seedTracker/seedTrackerScheduler.js` — expiry call site.
- `src/services/seedTracker/__tests__/seedTrackerEmbeds.test.js` — test updates.

## 1. Seed Progress track (`buildMilestoneTrack`)

Collapse `TRACK_GLYPH` to `{ done: '⬤', remain: '◯' }`. Remove the halfway
(`⬥/⬦`) and goal (`⨀/⊙`) branches. Every node is `⬤` (reached) or `◯`
(remaining), joined by `━━`. `done` stays clamped to `[0, total]`.

Example (5 / 10): `⬤━━⬤━━⬤━━⬤━━⬤━━◯━━◯━━◯━━◯━━◯`

## 2. Thanks for seeding! (`buildSeederThanksEmbed`)

New signature: `{ name, avatarUrl = null, streak = 0, totalDays = 0 }`.

Inline fields under the existing description:

- **Streak** — `${streak} days` — only when `streak >= 2` (omitted otherwise).
- **Total seeded** — `${totalDays} day(s)` — always shown.

Service `thankWhitelistedSeeder` computes, in parallel with the avatar:

- `streak = getSeedStreak(steamID, serverId)` (existing).
- `totalDays = getTotalSeedDays(steamID, serverId)` (new).

### New query — `getTotalSeedDays(steamId, serverId)`

`COUNT(DISTINCT seed_date)` over `squadjs_seed_sessions` joined to
`squadjs_players`, `status = 'completed'`, scoped to `serverId`, **no date
window** (all-time). Read-only on the `squadjs` pool. Returns `0` on error.

## 3. Whitelist Expiring Soon (`buildExpiryWarningEmbed`) — redesign

New signature: `{ name, steamId, avatarUrl = null, expiresAt, uniqueDays,
required, seedsNeeded }`.

- Steam avatar thumbnail.
- Description: `**{name}**, your seed whitelist is expiring soon — seed again to
  keep it!` followed by the `⬤/◯` renewal track and `**{done} / {required} days**`.
- Inline fields:
  - **Expires** — `<t:…:R>` relative timestamp.
  - **To renew** — `seedsNeeded === 0` → `Seed once to renew`, else
    `${seedsNeeded} more day(s)`.
  - **Steam ID** — full width.
- Color stays `COLOR_WARNING` (yellow).

Scheduler `checkExpiringWhitelists`: import `getAvatarUrl`, fetch the avatar per
entry, pass `expiresAt` / `uniqueDays` / `required` / `seedsNeeded`. Drop the
now-unused `daysRemaining` computation.

## 4. DM progression alignment (`buildDmProgressionEmbed`)

Swap the `[###---]` `buildProgressBar` for `buildMilestoneTrack(stats.uniqueDays,
requiredDays)` in the description. Keep the existing `Days` field. `buildProgressBar`
becomes unused and is removed.

## Out of scope

The Milestone "Halfway / Goal Reached" embed (`buildMilestoneEmbed`) is untouched.

## Testing

Unit tests in `seedTrackerEmbeds.test.js`:

- `buildMilestoneTrack` — rewrite expectations to the plain-circle scheme at
  0/half/full/clamp/non-default-total.
- `buildProgressionEmbed` — update the track assertion.
- `buildSeederThanksEmbed` — Total seeded always present; Streak present at `>=2`,
  absent at `1`.
- `buildExpiryWarningEmbed` — new: avatar thumbnail, relative `Expires`, track,
  and `To renew` wording for both `seedsNeeded > 0` and `=== 0`.

Run: `bun test src/services/seedTracker`.

## Deployment

Bump `package.json` `2.24.0 → 2.25.0`. No slash-command or schema changes.
Push `main` (staging), then merge `main → production` and push (prod). Verify
both via `gh run list`.
