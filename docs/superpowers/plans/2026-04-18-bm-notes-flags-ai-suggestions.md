# BattleMetrics Notes & Flags in AI Suggestions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Feed BattleMetrics staff notes and flags into the prospect-application AI and the ticket AI prompts via a single cached BM call.

**Architecture:** Add a combined `getPlayerProfile(steamId)` to `battlemetricsService.js` that does one `GET /players/{id}?include=...` call returning `{ bans, notes, flags }` with a 15-minute in-memory TTL cache. A shared formatter in `src/services/ai/bmFormat.js` renders notes and flags consistently. Both AI services (`prospectAiService.js`, `aiService.js`) consume the combined profile and include the two new sections in their prompts; system prompts are updated to tell the model to weight staff annotations.

**Tech Stack:** Bun, ESM, node `fetch`, `@anthropic-ai/sdk`. Project has no test framework configured (verified in `package.json`) — verification is manual per the design spec.

**Spec reference:** `docs/superpowers/specs/2026-04-18-bm-notes-flags-ai-suggestions-design.md`

---

## File Structure

**New files:**
- `src/services/ai/bmFormat.js` — shared formatters: `formatBMNotes(notes)`, `formatBMFlags(flags)`.

**Modified files:**
- `src/services/battlemetricsService.js` — add `getPlayerProfile(steamId)` plus TTL cache. Keep existing `getPlayerBans` / `getPlayerNotes` unchanged.
- `src/services/prospect/prospectService.js` — replace `bm.getPlayerBans(steamId)` call at line 127 with `bm.getPlayerProfile(steamId)`; destructure into `bmBans`/`bmNotes`/`bmFlags`; pass all three to `generateProspectEvaluation`.
- `src/services/ai/prospectAiService.js` — `buildStatsContext` reads `stats.bmNotes` / `stats.bmFlags` and renders new sections.
- `src/data/prospect-evaluation.txt` — mention BM notes and BM flags in the evaluation criteria.
- `src/services/ai/aiService.js` — replace the two parallel BM calls in `generateTicketSuggestion` with one `getPlayerProfile` call; extend `buildExternalDataSection` to render flags; extend system prompt to mention flags.

---

## Task 1: Verify BM API response shape for flags

**Files:** none (discovery only)

Before writing code, confirm what `GET /players/{id}?include=flagPlayer,playerFlag,playerNote` actually returns. The existing code uses `include=playerNote`, but the flag object shape is not proven in the codebase.

- [ ] **Step 1: Make a one-off curl against BM API**

Using a known BM player ID (resolve one via `playerSearch` in the Bun REPL, or pick one from the `bm_players` table):

```bash
# Replace <TOKEN> and <PLAYER_ID>
curl -s -H "Authorization: Bearer <TOKEN>" \
  "https://api.battlemetrics.com/players/<PLAYER_ID>?include=flagPlayer,playerFlag,playerNote" \
  | jq '.included | group_by(.type) | map({type: .[0].type, count: length, sample: .[0]})'
```

Expected: three groups — `playerFlag` (individual flag assignments, has `attributes.addedAt` and a relationship to `playerFlag`... actually BM terminology varies), `playerNote`, and the flag definitions themselves. Note which `type` field carries `attributes.name`, `attributes.description`, `attributes.icon`, `attributes.color`.

- [ ] **Step 2: Record findings in a comment block**

Add a comment at the top of `src/services/battlemetricsService.js` above the new function (see Task 2) with the exact `type` names observed. Typical BM shape:

```
// BM /players/:id include response (confirmed YYYY-MM-DD):
//   type: "playerNote"   attrs: note, createdAt, clearanceLevel
//   type: "flagPlayer"   attrs: addedAt (a join row; has relationships.playerFlag.data.id)
//   type: "playerFlag"   attrs: name, description, icon, color
// To render the flag list we need BOTH flagPlayer (which flags are on this player)
// AND playerFlag (the flag definitions by id), then join in memory.
```

If the actual shape differs (e.g., flag attributes inline on `flagPlayer`), adjust subsequent tasks accordingly. Do not guess.

- [ ] **Step 3: Do not commit yet** — findings land inside Task 2's commit.

---

## Task 2: Add `getPlayerProfile` and TTL cache to `battlemetricsService.js`

**Files:**
- Modify: `src/services/battlemetricsService.js` (add new function + cache near the existing `playerIdCache` at line 8, new function near the end of the file)

- [ ] **Step 1: Add the TTL cache declaration**

At the top of `src/services/battlemetricsService.js`, immediately after line 8 (`const playerIdCache = new Map();`), insert:

```js
// Combined profile cache: { bans, notes, flags } keyed by steamId. 15-min TTL, ~200 entries LRU.
const PROFILE_TTL_MS = 15 * 60 * 1000;
const PROFILE_CACHE_MAX = 200;
const profileCache = new Map(); // Map<steamId, { value, expiresAt }>

function profileCacheGet(steamId) {
  const entry = profileCache.get(steamId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    profileCache.delete(steamId);
    return null;
  }
  // Touch for LRU ordering
  profileCache.delete(steamId);
  profileCache.set(steamId, entry);
  return entry.value;
}

function profileCacheSet(steamId, value) {
  if (profileCache.has(steamId)) profileCache.delete(steamId);
  profileCache.set(steamId, { value, expiresAt: Date.now() + PROFILE_TTL_MS });
  while (profileCache.size > PROFILE_CACHE_MAX) {
    const oldestKey = profileCache.keys().next().value;
    profileCache.delete(oldestKey);
  }
}
```

- [ ] **Step 2: Add the `getPlayerProfile` function**

Append to the end of `src/services/battlemetricsService.js` (after `resolveAndGetStats` at line 267):

```js
// See discovery notes at top of file for BM include response shape.
export async function getPlayerProfile(steamId) {
  if (!isConfigured()) return null;

  const cached = profileCacheGet(steamId);
  if (cached) {
    log.debug({ steamId }, 'BM: profile cache hit');
    return cached;
  }

  try {
    const result = await playerSearch(steamId);
    if (!result) return null;
    const { playerId } = result;

    log.info({ steamId, playerId }, 'BM: fetching player profile (bans+notes+flags)');
    const url = `${BASE_URL}/players/${playerId}?include=flagPlayer,playerFlag,playerNote`;
    const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      log.warn({ steamId, status: res.status }, 'BM: player profile returned non-OK status');
      return null;
    }
    const json = await res.json();

    // Index flag definitions by id (confirm type name in Task 1)
    const flagDefsById = new Map();
    const flagAssignments = [];
    const notes = [];

    for (const item of json?.included ?? []) {
      if (item.type === 'playerNote') {
        notes.push({
          id: item.id,
          note: item.attributes?.note || '',
          createdAt: item.attributes?.createdAt || null,
          clearanceLevel: item.attributes?.clearanceLevel ?? null,
        });
      } else if (item.type === 'playerFlag') {
        flagDefsById.set(item.id, {
          id: item.id,
          name: item.attributes?.name || 'Unnamed flag',
          description: item.attributes?.description || '',
          icon: item.attributes?.icon || null,
          color: item.attributes?.color || null,
        });
      } else if (item.type === 'flagPlayer') {
        const flagId = item.relationships?.playerFlag?.data?.id;
        if (flagId) flagAssignments.push(flagId);
      }
    }

    notes.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const flags = flagAssignments
      .map((id) => flagDefsById.get(id))
      .filter(Boolean);

    // Bans are fetched via the separate /bans endpoint (same call pattern as getPlayerBans).
    // We call it here so callers get one combined object.
    const bans = await getPlayerBans(steamId);

    const profile = { bans: bans ?? { activeBans: [], expiredBanCount: 0 }, notes, flags };
    profileCacheSet(steamId, profile);
    return profile;
  } catch (err) {
    log.warn({ err, steamId }, 'BM: player profile fetch failed');
    return null;
  }
}
```

**Note on the `bans` field:** the `/players/{id}?include=ban` variant does not reliably include server names (needed for our render format); reusing `getPlayerBans` keeps ban output identical to today. It adds one extra HTTP call but both are cache-friendly.

- [ ] **Step 3: Smoke-test from a Bun REPL**

```bash
cd C:/Users/OleEd/Azure/RoyalSecretaryDiscordBot
bun repl
```

```js
const bm = await import('./src/services/battlemetricsService.js');
const p = await bm.getPlayerProfile('<known steam id>');
console.log('bans:', p.bans.activeBans.length, 'notes:', p.notes.length, 'flags:', p.flags.length);
console.log('sample flag:', p.flags[0]);
console.log('sample note:', p.notes[0]);
// Call again, should log "profile cache hit" at debug
const p2 = await bm.getPlayerProfile('<same steam id>');
```

Expected: non-zero counts for a known-flagged player; the second call does not hit the API (watch log output).

- [ ] **Step 4: Commit**

```bash
git add src/services/battlemetricsService.js
git commit -m "feat(battlemetrics): add getPlayerProfile with 15-min TTL cache"
```

---

## Task 3: Add shared formatters in `src/services/ai/bmFormat.js`

**Files:**
- Create: `src/services/ai/bmFormat.js`

- [ ] **Step 1: Write `bmFormat.js`**

```js
// Shared BattleMetrics renderers for AI prompt sections.
// Kept plain (no Discord markdown) since output goes to the LLM, not to chat.

export function formatBMNotes(notes) {
  if (!notes || notes.length === 0) return '';
  const lines = [];
  for (const n of notes) {
    const date = n.createdAt ? new Date(n.createdAt).toISOString().slice(0, 10) : '?';
    const text = (n.note || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    lines.push(`- [${date}] ${text}`);
  }
  return lines.join('\n');
}

export function formatBMFlags(flags) {
  if (!flags || flags.length === 0) return '';
  const lines = [];
  for (const f of flags) {
    const name = f.name || 'Unnamed flag';
    const desc = (f.description || '').replace(/\s+/g, ' ').trim();
    lines.push(desc ? `- ${name}: ${desc}` : `- ${name}`);
  }
  return lines.join('\n');
}
```

- [ ] **Step 2: Quick sanity check**

```bash
bun repl
```

```js
const { formatBMNotes, formatBMFlags } = await import('./src/services/ai/bmFormat.js');
console.log(formatBMNotes([{ createdAt: '2026-01-01T00:00:00Z', note: 'Applied previously' }]));
console.log(formatBMFlags([{ name: 'Recruit-watch', description: 'Under observation' }, { name: 'No-desc' }]));
```

Expected:
```
- [2026-01-01] Applied previously
- Recruit-watch: Under observation
- No-desc
```

- [ ] **Step 3: Commit**

```bash
git add src/services/ai/bmFormat.js
git commit -m "feat(ai): add shared BM notes and flags formatters"
```

---

## Task 4: Wire `getPlayerProfile` into the prospect fetch flow

**Files:**
- Modify: `src/services/prospect/prospectService.js` (lines 120–129 and 227 — `Promise.all` and destructure)

- [ ] **Step 1: Replace the `getPlayerBans` call with `getPlayerProfile` in `appendAllStatsToMessage`**

In `src/services/prospect/prospectService.js`, change the `Promise.all` block starting at line 120.

**Before (lines 120–129):**

```js
  Promise.all([
    getConnectionStats(steamId, start).catch(() => null),
    getPlaytime(steamId, start).catch(() => null),
    getPlayerSeedStats(steamId, 30).catch(() => null),
    getSeedStreak(steamId).catch(() => 0),
    getActivitySummary(userId, start, now).catch(() => null),
    fetchCblData(steamId).catch(() => null),
    bm.getPlayerBans(steamId).catch(() => null),
    getSteamBans(steamId).catch(() => null),
  ]).then(async ([connStats, playtime, seedStats, seedStreak, activity, cblData, bmBans, steamBans]) => {
```

**After:**

```js
  Promise.all([
    getConnectionStats(steamId, start).catch(() => null),
    getPlaytime(steamId, start).catch(() => null),
    getPlayerSeedStats(steamId, 30).catch(() => null),
    getSeedStreak(steamId).catch(() => 0),
    getActivitySummary(userId, start, now).catch(() => null),
    fetchCblData(steamId).catch(() => null),
    bm.getPlayerProfile(steamId).catch(() => null),
    getSteamBans(steamId).catch(() => null),
  ]).then(async ([connStats, playtime, seedStats, seedStreak, activity, cblData, bmProfile, steamBans]) => {
    const bmBans = bmProfile?.bans || null;
    const bmNotes = bmProfile?.notes || [];
    const bmFlags = bmProfile?.flags || [];
```

- [ ] **Step 2: Update the `generateProspectEvaluation` call to pass notes and flags**

Find the existing call near line 226 and change the stats object passed in.

**Before (line 226–228):**

```js
        const aiText = await generateProspectEvaluation(prospect, {
          connStats, playtime, seedStats, seedStreak, activity, cblData, bmBans, steamBans,
        });
```

**After:**

```js
        const aiText = await generateProspectEvaluation(prospect, {
          connStats, playtime, seedStats, seedStreak, activity, cblData, bmBans, bmNotes, bmFlags, steamBans,
        });
```

- [ ] **Step 3: Commit**

```bash
git add src/services/prospect/prospectService.js
git commit -m "feat(prospect): pass BM notes and flags into AI evaluation"
```

---

## Task 5: Render notes and flags in `prospectAiService.js`

**Files:**
- Modify: `src/services/ai/prospectAiService.js` (add import at line 7, extend `buildStatsContext` after line 86)

- [ ] **Step 1: Add formatter import**

At the top of `src/services/ai/prospectAiService.js`, add after the existing imports (line 7):

```js
import { formatBMNotes, formatBMFlags } from './bmFormat.js'
```

- [ ] **Step 2: Extend `buildStatsContext` to render BM notes and flags**

After the `if (stats.bmBans)` block (currently ends at line 86), insert:

```js
  if (stats.bmNotes && stats.bmNotes.length > 0) {
    lines.push('BATTLEMETRICS STAFF NOTES:')
    const rendered = formatBMNotes(stats.bmNotes)
    for (const line of rendered.split('\n')) lines.push(`  ${line}`)
  }

  if (stats.bmFlags && stats.bmFlags.length > 0) {
    lines.push('BATTLEMETRICS FLAGS:')
    const rendered = formatBMFlags(stats.bmFlags)
    for (const line of rendered.split('\n')) lines.push(`  ${line}`)
  }
```

Empty lists stay out of the prompt (no `(none)` filler).

- [ ] **Step 3: Commit**

```bash
git add src/services/ai/prospectAiService.js
git commit -m "feat(prospect-ai): render BM notes and flags in stats context"
```

---

## Task 6: Update prospect system prompt to weight staff annotations

**Files:**
- Modify: `src/data/prospect-evaluation.txt` (add a new subsection)

- [ ] **Step 1: Append a new section to `prospect-evaluation.txt`**

Insert the following block after the "GREEN FLAGS" section and before "OVERALL ASSESSMENT GUIDANCE":

```
BATTLEMETRICS STAFF ANNOTATIONS (HIGH-SIGNAL)
----------------------------------------------
Two sections may appear in the fetched data:
- BATTLEMETRICS STAFF NOTES: free-text observations written by RB admins about this player (past tickets, prior applications, behaviour patterns).
- BATTLEMETRICS FLAGS: named tags applied by admins (e.g. "Recruit-watch", "Positive-behavior"). Each flag lists its description.

Treat notes and flags as high-weight staff-authored context. They outrank self-reported application content where they conflict.

- If a note or flag contradicts an application claim (e.g. applicant says "no prior RB involvement" but a note describes a prior stay), surface the contradiction in the Flags output section.
- Do not quote note text verbatim unless the contradiction requires it; summarise the concern.
- Positive flags (e.g. "Whitelisted", "Trusted") should count as green signals in the Positives section.
- Negative flags (e.g. "Cheater-adjacent", "Recruit-watch") should count as red flags — cite the flag name.
```

- [ ] **Step 2: Commit**

```bash
git add src/data/prospect-evaluation.txt
git commit -m "docs(prospect-ai): add BM notes and flags guidance to evaluation prompt"
```

---

## Task 7: Wire `getPlayerProfile` into the ticket AI + render flags

**Files:**
- Modify: `src/services/ai/aiService.js` (imports at line 10, `buildExternalDataSection` signature + body at lines 128–190, `buildSystemPrompt` at line 228, `generateTicketSuggestion` at lines 320–335)

- [ ] **Step 1: Update imports**

Replace line 10:

```js
import { getPlayerBans, getPlayerNotes } from '../battlemetricsService.js'
```

with:

```js
import { getPlayerProfile } from '../battlemetricsService.js'
import { formatBMNotes, formatBMFlags } from './bmFormat.js'
```

- [ ] **Step 2: Update `buildExternalDataSection` signature and notes render**

At line 128, change the destructure:

**Before:**
```js
function buildExternalDataSection({ steamId, cblData, steamProfile, steamBans, bmBans, bmNotes }) {
```

**After:**
```js
function buildExternalDataSection({ steamId, cblData, steamProfile, steamBans, bmBans, bmNotes, bmFlags }) {
```

Replace the existing bmNotes block (lines 180–187):

**Before:**
```js
  if (bmNotes && bmNotes.length > 0) {
    const lines = []
    for (const n of bmNotes.slice(0, 10)) {
      const date = n.createdAt ? new Date(n.createdAt).toISOString().slice(0, 10) : '?'
      lines.push(`- [${date}] ${n.note}`)
    }
    sections.push('BATTLEMETRICS STAFF NOTES:\n' + lines.map((l) => `  ${l}`).join('\n'))
  }
```

**After:**
```js
  if (bmNotes && bmNotes.length > 0) {
    const rendered = formatBMNotes(bmNotes.slice(0, 10))
    sections.push('BATTLEMETRICS STAFF NOTES:\n' + rendered.split('\n').map((l) => `  ${l}`).join('\n'))
  }

  if (bmFlags && bmFlags.length > 0) {
    const rendered = formatBMFlags(bmFlags)
    sections.push('BATTLEMETRICS FLAGS:\n' + rendered.split('\n').map((l) => `  ${l}`).join('\n'))
  }
```

- [ ] **Step 3: Extend system prompt to mention flags**

In `buildSystemPrompt` at line 228–229, update the **External Data Flags** section description.

**Before:**
```
**External Data Flags:**
[Flag any concerning findings from the external player data: VAC/game bans, CBL active bans or high risk rating, BattleMetrics bans, concerning staff notes, private Steam profile, very new account. If nothing concerning is found, say "No flags from external data." Be specific about what you found and cite the data.]
```

**After:**
```
**External Data Flags:**
[Flag any concerning findings from the external player data: VAC/game bans, CBL active bans or high risk rating, BattleMetrics bans, concerning staff notes, concerning BattleMetrics flags (e.g. "Recruit-watch", "Cheater-adjacent"), private Steam profile, very new account. Positive flags (e.g. "Whitelisted", "Trusted") should reduce concern. If nothing concerning is found, say "No flags from external data." Be specific about what you found and cite the data.]
```

Also update the closing line at line 237:

**Before:**
```
Consider external player data (bans, risk ratings, staff notes) when assessing the situation and suggesting actions.
```

**After:**
```
Consider external player data (bans, risk ratings, staff notes, BattleMetrics flags) when assessing the situation and suggesting actions. Staff notes and flags are admin-authored and outrank self-reported user content.
```

- [ ] **Step 4: Replace the two parallel BM calls with one profile call**

In `generateTicketSuggestion`, replace the `Promise.all` block (lines 320–329):

**Before:**
```js
  const [messages, userHistory, similarCases, cblData, steamProfile, steamBans, bmBans, bmNotes] = await Promise.all([
    getTicketMessages(ticket.id),
    getUserTicketHistory(ticket.user_id),
    findSimilarTickets(ticket.reason, ticket.id, ticket.user_id),
    steamId ? fetchCblData(steamId).catch(() => null) : null,
    steamId ? getSteamProfile(steamId).catch(() => null) : null,
    steamId ? getSteamBans(steamId).catch(() => null) : null,
    steamId ? getPlayerBans(steamId).catch(() => null) : null,
    steamId ? getPlayerNotes(steamId).catch(() => null) : null,
  ])
```

**After:**
```js
  const [messages, userHistory, similarCases, cblData, steamProfile, steamBans, bmProfile] = await Promise.all([
    getTicketMessages(ticket.id),
    getUserTicketHistory(ticket.user_id),
    findSimilarTickets(ticket.reason, ticket.id, ticket.user_id),
    steamId ? fetchCblData(steamId).catch(() => null) : null,
    steamId ? getSteamProfile(steamId).catch(() => null) : null,
    steamId ? getSteamBans(steamId).catch(() => null) : null,
    steamId ? getPlayerProfile(steamId).catch(() => null) : null,
  ])

  const bmBans = bmProfile?.bans || null
  const bmNotes = bmProfile?.notes || []
  const bmFlags = bmProfile?.flags || []
```

- [ ] **Step 5: Update the `buildExternalDataSection` call**

Line 335 — add `bmFlags` to the object passed in.

**Before:**
```js
  const externalDataSection = buildExternalDataSection({ steamId, cblData, steamProfile, steamBans, bmBans, bmNotes })
```

**After:**
```js
  const externalDataSection = buildExternalDataSection({ steamId, cblData, steamProfile, steamBans, bmBans, bmNotes, bmFlags })
```

- [ ] **Step 6: Commit**

```bash
git add src/services/ai/aiService.js
git commit -m "feat(ticket-ai): add BM flags to prompt and use combined profile fetch"
```

---

## Task 8: Manual verification

**Files:** none

- [ ] **Step 1: Start the bot in dev mode**

```bash
cd C:/Users/OleEd/Azure/RoyalSecretaryDiscordBot
bun run dev
```

- [ ] **Step 2: Verify prospect AI reads notes + flags**

Trigger a prospect application flow (or re-post an existing prospect embed that triggers `appendAllStatsToMessage`) for a Steam ID known to have BM notes **and** at least one BM flag applied in your organization.

Check the generated **AI Assessment** embed. Confirm:
- At least one note or flag is cited in Flags / Positives / Summary
- No crash if the player has zero notes or zero flags

Also tail the dev log: on a fresh call you should see `BM: fetching player profile (bans+notes+flags)`. Re-trigger within 15 minutes and confirm no second fetch log appears (cache hit).

- [ ] **Step 3: Verify ticket AI reads flags**

In a test support ticket, invoke the AI suggestion command (used by the allowed user `ALLOWED_USER_ID`). Against a user whose linked Steam ID has BM flags, confirm:
- The **External Data Flags** section references at least one BM flag by name
- Notes still render (regression check)

- [ ] **Step 4: Verify graceful degradation**

Temporarily unset `BM_TOKEN` in `.env`, restart the bot, trigger a prospect flow. Expected: `isConfigured()` returns false, `getPlayerProfile` returns `null`, `bmBans`/`bmNotes`/`bmFlags` default to `null`/`[]`, AI runs without the BM sections, no crash. Restore the token afterwards.

- [ ] **Step 5: Clean up any debug logging**

If temporary logs were added during verification, remove them. If nothing was added, skip.

- [ ] **Step 6: Final commit (only if cleanup was needed)**

```bash
git add -u
git commit -m "chore(ai): remove verification debug logs"
```

---

## Done

At this point the spec is fully implemented: prospect AI and ticket AI both receive BM notes and BM flags via a single cached combined fetch, with graceful degradation when BM is unreachable.
