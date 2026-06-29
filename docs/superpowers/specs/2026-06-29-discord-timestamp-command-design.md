# `/timestamp` — Discord-native timezone timestamp generator

**Date:** 2026-06-29
**Status:** Approved (design)

## Problem

When staff arrange a time for something (a meeting, a prospect interview, a ticket
follow-up) the community is international, so a single wall-clock time means different
things to different people. Today we paste the time into an external website to get a
Discord timestamp code (`<t:UNIX:style>`), which Discord then renders in each viewer's
own local time. We want to remove the website dependency and do this natively in the bot.

## Goal

A slash command, available to **everyone**, that turns a human-entered local date/time
plus a timezone into a Discord timestamp. The user's timezone is remembered after first
use, so the everyday call is just `/timestamp date:… time:…`.

## Chosen approach

Slash command with options + timezone autocomplete + a remembered per-user timezone
(Approach 2 from brainstorming). The reply is an **ephemeral** message that shows the
moment in every Discord style with each copyable code, a style dropdown, and a
"Post to this channel" button.

Approaches considered and rejected for v1: a multi-step builder embed with dropdowns
(more components/state than needed), a natural-language modal (`"next Friday 8pm"` —
needs a parser dependency and ambiguity handling), and a fully click-driven stepper
(clunky for picking dates weeks out).

## Command surface

### `/timestamp` (everyone)
Options:
- `date` (string, **required**) — format `YYYY-MM-DD`. Description carries the format hint.
- `time` (string, **required**) — accepts 24-hour (`18:00`) **or** 12-hour (`6:00 PM`).
- `timezone` (string, optional, **autocomplete**) — IANA zone. Typing filters the list;
  each suggestion shows the zone's current local time, e.g. `Europe/Oslo — 19:42`.

Timezone resolution:
- If `timezone` is supplied, it is used for this call **and** saved as the user's default.
- If omitted and the user has a saved default, the default is used.
- If omitted and no default exists, reply with a friendly ephemeral nudge:
  *"Set your timezone once with the `timezone` option and I'll remember it for next time."*

### `/timezone` (everyone)
- No options. Ephemeral reply shows the user's saved zone and its current local time
  (or "none set"), plus a **Clear** button (`tz_clear`).
- Setting is done through `/timestamp`'s `timezone` option, so this command is view/clear only.

## The ephemeral reply (`/timestamp`)

A single ephemeral message containing:

1. **Styles preview block** — for each style in `F, f, D, d, t, T, R`, one line with the
   live-rendered timestamp next to its copyable code, e.g.:
   `**Long Date/Time** — <t:1782000000:F>  ·  ` `` `<t:1782000000:F>` ``
   Discord renders the `<t:…>` tokens and the backticked copy is the literal to paste.
2. **Style select** — `StringSelectMenu`, customId `ts_style:<unix>`, options for each
   style with friendly labels, default `F`.
3. **Post button** — `Button`, customId `ts_post:<unix>:<style>`, label "Post to this channel".

Interactions:
- Changing the **style select** re-renders the message (highlighting the chosen style) and
  rewrites the Post button's customId to the newly selected style via `interaction.update()`.
- Clicking **Post** sends the bare `<t:unix:style>` into the current channel as a normal bot
  message, so every member sees it in their own local time. The ephemeral reply stays.

**No server-side state:** the Unix epoch and chosen style are encoded entirely in the
component customIds (epoch is ~10 digits, well within the 100-char customId limit), so the
buttons keep working across bot restarts. This matches the project preference for avoiding
in-memory interaction state.

## Architecture & new code

Follows existing conventions: auto-loaded `{ data, execute }` commands, customId routing in
`interactionCreate.js`, `query()` on the `secretary` pool, table DDL in `schema.js`,
domain services under `src/services/{feature}/`.

- `src/commands/timestamp.js` — `{ data, execute, autocomplete }`.
- `src/commands/timezone.js` — `{ data, execute }` (view + Clear button).
- `src/services/timestamp/timeParse.js` — pure functions:
  - `parseTimeOfDay(str) -> { hour, minute } | null` — tolerant 24h/12h parsing (luxon
    `fromFormat` over a candidate format list, meridiem normalized).
  - `unixFromLocal(dateStr, timeStr, zone) -> { unix } | { error }` — composes date + time
    in `zone` via `DateTime.fromObject({...}, { zone })`, validates `.isValid`, returns
    `Math.floor(dt.toSeconds())`.
- `src/services/timestamp/timestampService.js` — `getUserTimezone(discordId)`,
  `setUserTimezone(discordId, tz)` (UPSERT via `INSERT … ON DUPLICATE KEY UPDATE`),
  `clearUserTimezone(discordId)`. All parameterized, `secretary` pool.
- `src/services/timestamp/timestampView.js` — builds the styles preview text + the
  select/button component rows for a given `unix` and selected `style`.
- `src/handlers/timestampInteractions.js` — `handleStyleSelect`, `handlePostButton`,
  `handleClearTimezone`.
- `src/events/interactionCreate.js` — **add an autocomplete branch** that looks up the
  command and delegates to `command.autocomplete(interaction)` (no cooldown on autocomplete);
  register `ts_style:` (select), `ts_post:` (button), and `tz_clear` (button) in the routing.

### Timezone autocomplete
- Source the zone list from `Intl.supportedValuesOf('timeZone')`.
- Filter case-insensitively against the typed text (match on the full id and the city
  segment after `/`). Cap at Discord's 25-choice limit.
- For an empty query, show a curated short list of common community zones (with the user's
  saved zone first if set).
- Each choice: `name = \`${zone} — ${DateTime.now().setZone(zone).toFormat('HH:mm')}\``
  (≤100 chars), `value = zone`.

## Dependency & data

- Add **`luxon`** to `dependencies`. Rationale: DST-safe conversion of a local wall-clock
  time in an arbitrary IANA zone to a Unix epoch. Native `Date` would parse the string in
  the VPS's timezone (UTC), producing wrong epochs — the exact bug this feature avoids.
- New table in `src/database/schema.js`:
  ```sql
  CREATE TABLE IF NOT EXISTS user_timezone (
    discord_id VARCHAR(32) NOT NULL PRIMARY KEY,
    timezone   VARCHAR(64) NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  );
  ```

## Error handling

All failures produce a friendly ephemeral message; nothing throws to the user:
- Malformed `date` (not `YYYY-MM-DD`) — example shown.
- Unparseable `time` — example shown (`18:00` or `6:00 PM`).
- Impossible date (e.g. Feb 30) — caught via luxon `invalid`.
- Invalid timezone (submitted value not a valid IANA zone) — validated with
  `IANAZone.isValidZone`; reject and ask the user to pick from autocomplete.
- No timezone set and none supplied — the nudge described above.
- DST gaps/overlaps are resolved by luxon's default behavior (acceptable; documented).

## Testing (`bun test`)

- `timeParse.js`: 24h, 12h with AM/PM (and lowercase `pm`), ISO date, invalid date string,
  impossible date (Feb 30), leap-year Feb 29, and a DST-boundary instant. Assert exact
  Unix epoch for a known zone.
- `timestampView.js`: emits the correct `<t:unix:style>` codes for every style and the
  correct default/selected style wiring.
- `timestampService.js`: UPSERT and clear issue the expected parameterized SQL (mocked `query`).

## Deployment

1. Bump the bot `package.json` version (minor) per the project's semver-on-push convention.
2. Register slash commands: `bun run deploy-commands` (registers `/timestamp` and
   `/timezone` with the Discord API; guild-scoped when `config.guild.id` is set).
3. Deploy to the VPS. Standard path is the GitHub Actions flow (push `main` → staging,
   merge `main` → `production` → prod). The user has asked to SSH into the VPS for this
   deploy — confirm at deploy time whether to use the standard CI flow or a manual
   container action on the VPS. The `user_timezone` table is created idempotently by
   `schema.js` on boot.

## Out of scope (v1, YAGNI)

- Natural-language / relative input (`"in 2h"`, `"next Friday 8pm"`).
- An optional meeting `label` posted alongside the timestamp.
- The multi-step builder-embed UI and the click-only stepper.
