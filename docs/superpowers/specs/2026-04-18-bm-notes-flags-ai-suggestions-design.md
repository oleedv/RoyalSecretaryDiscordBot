# BattleMetrics Notes & Flags in AI Suggestions — Design

**Date:** 2026-04-18
**Scope:** Discord bot (`RoyalSecretaryDiscordBot`)
**Affects:** Prospect application AI, Support ticket AI, BattleMetrics service

## Problem

The AI suggestion prompts for prospect applications and support tickets lack staff-authored BattleMetrics context. The ticket AI already pulls BM notes, but BM flags are absent everywhere, and the prospect AI pulls no notes or flags at all. Flags and notes contain high-signal information (recruit status, prior drama, ban reasoning, trust markers) that reviewers rely on. Feeding this context to the LLM should produce more informed suggestions and surface contradictions between an applicant's claims and staff observations.

## Goals

- Prospect AI receives BM notes and BM flags, rendered in the user message alongside existing stats.
- Ticket AI receives BM flags, rendered alongside the existing BM notes block.
- A single BM call returns bans, notes, and flags together.
- Short-lived in-memory caching avoids redundant calls when the same player triggers multiple AI runs in quick succession.
- Graceful degradation: if BM is unreachable, the AI still runs with other data.

## Non-goals

- No changes to how flags are added/removed (`addFlag`, `removeFlag` remain untouched).
- No rework of existing `getPlayerBans` / `getPlayerNotes` consumers — additive only.
- No categorization or filtering of flags; flag name + description passed raw.
- No privacy filtering of notes; reviewers are trusted.

## Design

### 1. `battlemetricsService.js` — new `getPlayerProfile(steamId)`

Add a combined fetch function that resolves the BM player ID via the existing 3-tier cache (memory → DB → API) and performs **one** request:

```
GET /players/{id}?include=playerNote,flagPlayer,flag,ban
```

The response `included` array is split by `type` into `{ bans, notes, flags }`.

**Returned shape:**

```js
{
  bans: [ /* same shape getPlayerBans currently returns */ ],
  notes: [ { id, note, createdAt, clearanceLevel } ],
  flags: [ { id, name, description, icon, color } ]
}
```

Existing `getPlayerBans` and `getPlayerNotes` remain exported and unchanged for any other caller.

**Caching:** new in-memory LRU cache keyed by `steamId`, TTL = 15 min, max ~200 entries. Located near the top of `battlemetricsService.js` next to the existing caches. Cache holds the full `{ bans, notes, flags }` object. No DB persistence (staff edits should flush quickly).

**Error handling:** BM 404 on player → return `{ bans: [], notes: [], flags: [] }`. Other errors bubble to the caller's existing try/catch.

### 2. `prospectAiService.js` — extend stats context

In `buildStatsContext()` (currently `src/services/ai/prospectAiService.js:21-102`), replace the current BM bans fetch with a single `getPlayerProfile()` call. Render bans as before and add two new sections to the user message:

```
BattleMetrics Notes:
- [2025-12-04] Applied previously, withdrew. Seemed mature.
- [2024-08-11] Playing with known toxic clan on EU4.

BattleMetrics Flags:
- Recruit-watch: Under observation for recruitment
- Positive-behavior: Helpful in seeding sessions
```

Notes sorted newest first. Both sections omitted entirely when their list is empty (no `"(none)"` filler, to save tokens).

Update `src/data/prospect-evaluation.txt` (the system prompt source) to tell the model:

- Notes and flags are staff annotations with higher weight than self-reported application content.
- Contradictions between application claims and notes/flags should surface in the **Flags** output section.

### 3. `aiService.js` (tickets) — add flags block

In `buildExternalDataSection()` (`src/services/ai/aiService.js:128-190`), after the existing BattleMetrics Notes block, append a `BattleMetrics Flags` block with the same render format as prospect.

In `generateTicketSuggestion()` (`aiService.js:316-361`), replace the parallel `getPlayerBans` + `getPlayerNotes` calls (lines 327-328) with a single `getPlayerProfile()` call. Destructure to feed the existing ban renderer, the existing note renderer, and the new flag renderer.

Update `buildSystemPrompt()` (`aiService.js:192-239`) to mention flags alongside notes as staff-authored context.

### 4. Render format (shared)

A tiny helper, colocated in `battlemetricsService.js` or a new `src/services/ai/bmFormat.js`:

```js
export function formatBMNotes(notes) { /* bullet list, newest first, "[YYYY-MM-DD] text" */ }
export function formatBMFlags(flags) { /* bullet list, "- Name: description" (description optional) */ }
```

Both AIs call the same formatter to keep output consistent. Empty lists → empty string (caller decides whether to include a header).

### 5. Error handling

Wrap `getPlayerProfile()` in the existing try/catch at each caller. On failure, log at warn level and render:

```
BattleMetrics Notes: (unavailable)
BattleMetrics Flags: (unavailable)
```

This matches the fallback pattern the ticket AI already uses for Steam/CBL outages.

### 6. Testing (manual)

- Run a `/prospect` flow against a Steam ID with known BM flags (e.g. `Recruit-watch`) and notes. Verify both sections appear in the prompt and in the Flags/Summary output from the model.
- Trigger a ticket AI suggestion on the same user. Verify the flags block lands in the prompt and the model references it in the Suggested Action / Rules Applied output when relevant.
- Run twice within 15 min to confirm the second call hits the cache (log the cache hit at debug level during development).
- Disable BM (invalid token) and verify the prompt still builds with `(unavailable)` lines and no crash.

## Files Touched

- `src/services/battlemetricsService.js` — new `getPlayerProfile`, new TTL cache
- `src/services/ai/prospectAiService.js` — replace BM bans call, add notes + flags rendering
- `src/services/ai/aiService.js` — replace BM bans/notes calls, add flags rendering, update system prompt
- `src/data/prospect-evaluation.txt` — prompt guidance for notes + flags
- (optional) `src/services/ai/bmFormat.js` — shared formatters, if inline gets unwieldy

## Open Questions

None at this time. Flag categorization and note privacy filtering were explicitly rejected in brainstorming.
