# Ticket duplicate-handling fixes + member-leave extension + DM-embed sweep

Date: 2026-06-17

## Background

Commit `eb6bb8d` fixed a double-emit bug where the raw-gateway DM fallback in
`bot.js` re-emitted a `messageCreate` that discord.js had already delivered,
double-posting a user's DM into the staff ticket channel. The bug class is
"one inbound event causing duplicated work / two events racing on the same
state". This change hunts for more of that class, plus two requested features.

## Part A - Duplicate-handling bug fix (reopen race)

`src/events/messageCreate.js` `handleDM`: when a user sends two DMs in quick
succession while their ticket is in the `closing` grace period, both pass the
`getClosingTicketByUser` check. The first `reopenTicket` wins; the second gets
`affectedRows === 0`, replies "This ticket is no longer available" and **drops
the user's second message** (never forwarded to staff).

Fix: on the reopen-error branch, re-fetch `getOpenTicketByUser`. If the ticket
is now open (the concurrent message won the race), forward this message to it
via `ticketMessages.handleDM` without re-running the rebuild/notice. Only if no
open ticket exists do we show the "open a new ticket" message (as an embed).

Everything else in the class is already safe: button double-clicks are guarded
by the 2s cooldown + atomic DB state checks; `channelDelete` only handles
temp-voice; the DM-fallback fix is robust.

## Part B - Member-leave notice extended to closing tickets

`src/events/guildMemberRemove.js` currently only checks `getOpenTicketByUser`.
Add a `getClosingTicketByUser` check so a user who leaves during the 2-hour
grace period also triggers a channel notice. `handleTicketMemberLeave` wording
keys off `ticket.status` ("still open" vs "in its closing grace period").
Scope: ticket creator only (not staff participants).

## Part C - Every bot -> user DM becomes an embed

Verify flow is in-guild ephemeral and is excluded. Sites converted from plain
text to embeds:

| Site | Change |
|------|--------|
| `ticketMessages.js` staff `!reply` relay | shared `buildRelayEmbed` (author = staff name + avatar, or "Staff"/grey when anonymous) |
| `prospectMessages.js` staff `!reply` relay | same shared `buildRelayEmbed` (type 'Prospect') |
| `ticketMessages.js` "file too large" notice | `infoEmbed` |
| `prospectMessages.js` "file too large" notice | `infoEmbed` |
| `dmQueue.js` `deliver()` | wraps stored string in `successEmbed` at send time; DB queue still stores plain text so retries work |
| `interactionCreate.js` cooldown reply | `errorEmbed` |
| `messageCreate.js` reopen-unavailable reply | `infoEmbed` (part of Part A) |

New shared helper `buildRelayEmbed({ type, senderName, avatarUrl, content, anonymous })`
in `src/utils/embed.js`. The user-facing relay embed does NOT carry the staff
"Sent anonymously" footer (that stays on the staff-channel log embed only).

## Testing

`bun test`. New/extended unit tests:
- `buildRelayEmbed` (pure): author/color/description; anonymous -> "Staff"/grey/no avatar.
- `handleTicketMemberLeave` wording for open vs closing.
- reopen-race: forwards to the now-open ticket instead of rejecting (mock.module).
- `dmQueue.sendOrQueueDm` delivers an embed payload, not a raw string.

## Logistics

- Branch `main` (= staging). Conventional commits, no AI attribution, no emojis.
- Version bump `2.13.0` -> `2.14.0`.
- Deploy: push `main` (staging), then merge `main` -> `production` and push (prod),
  verifying each via `gh run list`.
