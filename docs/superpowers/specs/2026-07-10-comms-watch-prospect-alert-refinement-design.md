# Comms-watch: prospect off-comms alert refinement + seeding exemption

**Date:** 2026-07-10
**Feature:** refinement of the comms-watch prospect alerter (bot v2.31.0 → v2.32.0)
**Area:** `src/services/commsWatch/`

## Background

The comms-watch feature posts a "Prospect off comms while in-game" embed into the
prospect's staff ticket (`prospects.channel_id`, which is staff-only — `@everyone` is
denied, only the bot + staff `roles` can view) and pings the mentor when a prospect has
been in-game on Main for 15 minutes without joining Discord voice. The alert fires **once
per off-comms episode** (an `alerted` flag dedupes it; it re-arms on voice rejoin or on
leaving the game).

Three refinements were requested.

## 1. Embed copy

`buildProspectAlertEmbed` in `commsWatchEmbeds.js`:

- **Title:** `Prospect off comms while in-game` → `Prospect not on Discord while in-game`.
- **Body:** `<@user> (**alias**) is playing on **Main** but hasn't joined Discord voice.`
- **Remove** the `Since` and `Duration` fields. Because the alert fires exactly at the
  15-minute threshold, both are effectively constant (~15 min) and add noise.
- **Signature simplified** to `buildProspectAlertEmbed({ userId, alias }, serverName)` — the
  `offCommsSince` / `offCommsMs` arguments are no longer needed. The single call site in
  `commsWatchMonitor.js` and the embed unit test are updated to match.
- Colour (red `0xed4245`) and the mentor ping in the message `content` are unchanged.

## 2. Seeding exemption (prospect-only, layer-based)

Prospects are **allowed** to play without Discord voice while the server is seeding, so the
alert must not fire during seeding.

- **Detection:** the server is "seeding" when it is on a **Seed layer** —
  `extractGameMode(state.currentLayer)?.toLowerCase() === 'seed'`, reusing the existing,
  format-robust helper exported from `seedingSocket.js` (handles both the underscore and the
  spaced-A2S layer formats). Computed once per monitor tick.
- **Scope:** per tracked person, `exempt = kind === 'prospect' && isSeeding`. Members are
  never exempt — their tracking and board presence are unchanged.
- The `exempt` flag is threaded into the pure `evaluateComms` state machine via the `obs`
  bag (`{ inGame, inVoice, exempt }`).

## 3. Fresh-15-min behaviour on seed → live

When `exempt` is true, `evaluateComms` returns a **soft reset** of the episode each tick:
`observedInVoice`, `voiceChangedAt`, `commsOk`, `offCommsSince` cleared and `alerted`
re-armed, while `inGameSince` is preserved. Consequences:

- While on a Seed layer the prospect is never `isOffComms` → no alert **and** they do not
  appear on `/comms-board` (consistent with "off-comms is allowed while seeding").
- Because the voice debounce is reset each exempt tick, the moment the server switches to a
  live (non-Seed) layer the off-comms clock **starts fresh from that transition** — the
  prospect must be off-comms for a full 15 minutes *of live play* before the alert fires,
  not counting the time spent seeding.

## Files changed

- `src/services/commsWatch/commsWatchEmbeds.js` — new copy + simplified signature.
- `src/services/commsWatch/commsWatchState.js` — `exempt` short-circuit branch in `evaluateComms`.
- `src/services/commsWatch/commsWatchMonitor.js` — compute `isSeeding` from the layer, thread
  `exempt` into `obs`, simplify the alert push + `buildProspectAlertEmbed` call.
- `src/services/commsWatch/__tests__/commsWatchEmbeds.test.js` — updated for the new title/copy
  and the absence of fields.
- `src/services/commsWatch/__tests__/commsWatchState.test.js` — added exempt cases: exempt
  short-circuits (never off-comms/alerts), and lifting the exemption starts a fresh
  grace + threshold window anchored to the transition.

## Out of scope / non-changes

- No new config keys, no schema change, no new/renamed slash command (so no command
  re-registration needed).
- Member behaviour, the `/comms-board` command, and the mentor-ping logic are unchanged.

## Deploy

- Version bump: **2.31.0 → 2.32.0** (new behaviour).
- Bot deploy mapping: push `main` → staging; merge `main` → `production` and push
  `production` → prod (a fast-forward push of a feature branch to `production` is rejected).
