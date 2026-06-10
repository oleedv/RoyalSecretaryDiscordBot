# Rotation embed: highlight current map + match timer

**Date:** 2026-06-10
**Status:** Approved (pending user review of this spec)

## Goal

Make the layer-rotation embed (channel id `1509632566548889773`, produced by `layerRotationValidatorEmbeds.buildSuccessEmbed`) show which rotation entry is being played right now and how long the match has been running. Today the embed lists the rotation but has no link to live server state.

## Non-goals

- No change to the validator (squadutils.org parsing) or the SFTP / channel-post ingestion paths.
- No persistent storage of the live layer / match start time. They are live data; if unknown at render time, render without the highlight and without the timer.
- No change to the error embed.

## Data sources

Both already exist for the server-status embeds:

- `getServerState(name).currentLayer` from `src/services/seeding/seedingSocket.js` — string like `Sumari_Seed_v1`.
- `getServerStats(name).matchStartTime` from `src/services/serverStatus/serverStatusQueries.js` — unix timestamp of the active row in `squadjs_matches` (`end_time IS NULL`).

The server name we look up is `config.seeding.seedingServer`. That is the same socket the seeding embeds use; the rotation file we already SFTP-fetch belongs to the same server.

If `currentLayer` is null, render without highlight. If `matchStartTime` is null, render without timer. Both independently optional.

## Matching policy

Compare `currentLayer` to the first whitespace-separated token of each rotation line, case-sensitive (rotation lines and live `currentLayer` both come from the game and use the same casing). Highlight the **first** matching line.

In `LayerList_Vote` mode the same layer may appear in multiple vote candidate blocks; we cannot know which block players actually voted on, so first-match is the honest answer.

If no line matches, no line is highlighted.

## Visual change

In `formatRow(line, idx, isCurrent)`:

- Current line: `:green_circle: **{idx}. {layer}** - *{teams}*`
- Other lines: `**{idx}.** {layer} - *{teams}*` (unchanged)

The bold spans the index AND the layer name on the current line so the highlight reads as one unit; on other lines only the index stays bold (matches current behavior).

## Timer line

In `buildSuccessEmbed`, the description currently reads:

```
Mode: LayerList_Vote (players vote)
Updated <t:1717000000:R>

**1.** ...
```

Add (when both `currentLayer` and `matchStartTime` are known) a block between the `Updated` line and the rotation list:

```
Mode: LayerList_Vote (players vote)
Updated <t:1717000000:R>

Current map: Mutaha RAAS v1
Started <t:1717003600:R>

:green_circle: **2. Mutaha RAAS v1** - *RGF vs USMC*
...
```

The "Mutaha RAAS v1" string uses the existing `prettifyLayerToken` formatter applied to `currentLayer` so it matches the rotation row spelling. If only `currentLayer` is known, omit the `Started` line. If only `matchStartTime` is known but no currentLayer (shouldn't happen in practice), omit the whole block.

The `<t:ts:R>` token self-updates in Discord clients, so the timer does not require any re-rendering.

## Refresh strategy

The embed must be re-rendered when the live layer changes. Approach:

1. Export a new function `refreshLiveLayerHighlight(client)` from `layerRotationValidatorScheduler.js`. It reads the persisted rotation (`readPersistedRotation`) plus the latest live `currentLayer` / `matchStartTime`, then calls `replaceLiveEmbed`. It is a no-op if there is no persisted rotation, the validator is disabled, or the configured `seedingServer` socket is not connected.
2. In `seedingSocket.js`'s `NEW_GAME` handler, after updating `conn.state.currentLayer`, lazy-import `refreshLiveLayerHighlight` (same pattern used for `processCompletedSession`) and call it — only when `serverCfg.name === config.seeding.seedingServer`.
3. The existing 5-minute SFTP tick is unchanged; it continues to detect rotation-file changes. When it calls `replaceLiveEmbed`, the live data is fetched there too so the embed is always consistent.

On cold boot, `restoreFromPersistence` calls `replaceLiveEmbed`, which now also tries to fetch live state. The socket may not be connected yet at that point; if so the embed renders without highlight, and the first `NEW_GAME` / A2S update triggers a re-render with the badge.

## Wiring inside `replaceLiveEmbed`

`replaceLiveEmbed` becomes the single chokepoint that resolves live state:

```js
async function readLiveLayerState() {
  const name = config.seeding?.seedingServer;
  if (!name) return { currentLayer: null, matchStartTime: null };
  const state = getServerState(name);
  if (!state?.connected) return { currentLayer: null, matchStartTime: null };
  const stats = await getServerStats(name).catch(() => ({}));
  return { currentLayer: state.currentLayer || null, matchStartTime: stats?.matchStartTime ?? null };
}
```

It is called once at the top of `replaceLiveEmbed`, the result is threaded into `buildSuccessEmbed`. The function is best-effort: any error returns nulls and the embed renders un-highlighted.

## Files touched

- `src/services/layerRotationValidator/layerRotationValidatorEmbeds.js`
  - `formatRow(line, idx, isCurrent)` — gain `isCurrent` flag.
  - `formatRotationList(lines, currentLayerToken)` — pass-through; computes which idx to highlight.
  - `buildSuccessEmbed({ mode, lines, currentLayer, matchStartTime })` — gains the two new fields, inserts the "Current map" block, threads token into `formatRotationList`.
- `src/services/layerRotationValidator/layerRotationValidatorScheduler.js`
  - `readLiveLayerState()` helper (private).
  - `replaceLiveEmbed` reads live state, passes to `buildSuccessEmbed`.
  - Export `refreshLiveLayerHighlight(client)`.
- `src/services/seeding/seedingSocket.js`
  - `NEW_GAME` handler invokes `refreshLiveLayerHighlight` for the seeding server (lazy import).
- `src/services/layerRotationValidator/__tests__/formatter.test.js`
  - New cases: highlight applied when current layer matches a line; no highlight when it does not; timer line present when `matchStartTime` provided; description omits the block when both are null.

## Open edge cases (decided)

- **Same layer appears N times in rotation:** highlight first occurrence only.
- **`currentLayer` matches no line:** render without highlight; do not log an error (legitimate during admin-set or one-off layers).
- **Socket disconnects mid-life:** `state.connected` is false, helper returns nulls, embed renders un-highlighted on next refresh. No special handling.
- **Cold boot before socket connects:** embed renders un-highlighted; first NEW_GAME / A2S update triggers `refreshLiveLayerHighlight`.

## Out of scope

- Showing time-remaining in match (we don't have a reliable end-of-round prediction).
- Highlighting on the error embed (errors mean the rotation is invalid; not meaningful to point at "current").
- Mode badge changes.
