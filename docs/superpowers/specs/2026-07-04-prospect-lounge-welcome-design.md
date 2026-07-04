# Prospect-Lounge Welcome Embed — Design

**Date:** 2026-07-04
**Status:** Approved (pending spec review)

## Problem

The legacy Python bot, on `/prospect add` (the moment a prospect passes their
interview and the prospect period begins), posted a plain welcome message into
the prospect lounge (`1237128127268913275`): it pinged everyone, pointed the
newcomer to a handful of prospect channels, and added a 👋 reaction.

The current JS bot performs the equivalent action in `acceptProspect()`
(`src/services/prospect/prospectService.js`) — adds the Prospect role, sets the
`P |` nickname, creates the forum thread, DMs the user — but posts **nothing**
to the prospect lounge. (The existing lounge post built by
`buildAcceptedAnnouncementEmbed` fires at a *different* moment,
`closeProspect('accepted')` — end of the prospect period, when the user becomes
a full member — and targets a different channel, `loungeChannelId`.)

We want to recreate the legacy welcome as a cleaner, styled embed showing the
prospect's Discord avatar.

## Trigger

`acceptProspect()`, after the existing atomic double-accept reservation guard
(`reserveResult`), so the post fires exactly once per acceptance. Placed near the
end of the function alongside the other side effects (staff embed, DM).

## Configuration

New keys under `config.prospects` (production IDs carried over from the Python
source). Dev/staging leave them empty; every use is guarded, so the feature is a
silent no-op there — the same pattern as the existing `loungeChannelId`.

| Key | Prod ID | Purpose |
|---|---|---|
| `prospectLoungeChannelId` | `1237128127268913275` | Channel the welcome embed is posted to |
| `prospectInfoChannelId` | `1237127788771934238` | "Get started" / info channel |
| `prospectIntroChannelId` | `1237128979845087353` | Introduce-yourself channel |
| `prospectAwayChannelId` | `1237128704484835419` | Going-away / put-on-hold channel |
| `feedbackChannelId` *(existing)* | `1237151891214041149` | Feedback channel (already configured) |

## Embed builder

New pure function `buildProspectWelcomeEmbed(member, prospect)` in
`src/services/prospect/prospectEmbeds.js`, built on `createEmbed('Prospect')`.

- **Style:** clean & minimal — restrained wording, minimal emoji.
- **Avatar:** thumbnail only (`member.user.displayAvatarURL()`), matching the
  other prospect embeds. Omitted gracefully if `member` is null.
- **Color:** `0x57f287` (green), matching the "accepted" theme.
- **Title:** `Welcome to the Prospect Lounge`
- **Description:** notes the prospect passed their interview and the prospect
  period has started; mentions `<@userId>`.
- **Fields** (each added only when its channel ID is configured): Get Started →
  `#info`, Introduce Yourself → `#intro`, Going Away? → `#away`, Feedback →
  `#feedback`.
- **Footer/timestamp:** inherited from `createEmbed` (`Royal Battalion ● Prospect`).

## Posting behaviour

In `acceptProspect()`:

- Guarded on `prospectLoungeChannelId` being set and the channel being fetchable.
- `channel.send({ content: '<@userId>', embeds: [embed], allowedMentions: { users: [userId] } })`
  — pings **only** the new prospect (no `@everyone`, no role pings).
- On success, add a 👋 reaction to the posted message.
- Wrapped in `.catch()` with `log.error` / `log.warn`, so a lounge failure never
  breaks the accept flow — same defensive style as the `closeProspect` lounge post.

## Testing

`bun test` unit test for the pure builder (in
`src/services/prospect/__tests__/`):

- Description contains the `<@userId>` mention.
- Thumbnail is set to the member avatar URL.
- Channel fields are present when the corresponding config IDs are set, and
  omitted when they are empty.
- Footer reads `Royal Battalion ● Prospect`.

## Out of scope

- No change to the existing member-welcome (`buildAcceptedAnnouncementEmbed` /
  `closeProspect`).
- No website or DB changes.

## Version

Bump `package.json` `2.28.0` → `2.29.0` (minor — new feature).
