# Layer Rotation Validator

## Goal

Every 5 minutes, fetch the Squad server's `Server.cfg` and `LayerRotation.cfg` from SFTP, validate the rotation against the squadutils.org parser API, and surface the result in Discord:

- When the rotation is valid, keep a single live embed in channel `1509632566548889773` showing the current rotation in a numbered table. Update only when the rotation or active mode actually changes.
- When the rotation has errors, post a single alert (with role pings to `1225894972084060290` and `733974178797191189`) to the existing alerts channel `1423733551257489501`. Do not touch the live embed in the prod channel.
- When the active rotation mode is anything other than `LayerList` or `LayerList_Vote` (i.e. `LayerRotation.cfg` is not authoritative), do nothing visible. Log a warning.

This ports the `parseMapRotation` capability from the Python bot (`Royal-secretary-discord-bot/royal_secretary/externalAPI.py`) — which only validated user-typed rotations in a Discord channel — into an automated, source-of-truth monitor driven by the actual server files.

## Scope

In scope:

- New service `src/services/layerRotationValidator/` with its own scheduler (5-minute interval, reusing `createScheduler`).
- New SFTP fetch path (only two specific files), independent of `ConfigGuardian`.
- New embed builder with a Squad layer-token prettifier.
- Aggressive channel clear on boot (the prod channel is treated as a single-purpose status surface; in-memory state is wiped across restarts). On subsequent changes, just the previous tracked message is deleted.
- New env var `SQUAD_UTILS_URL` (matches the Python bot's env name).
- New settings block per environment (`enabled` + `channelId` so dev/staging are disabled by default).

Out of scope:

- Reworking or coupling to `ConfigGuardian`. The two services share SFTP credentials but nothing else.
- Persisting the live-embed message ID to MariaDB. Boot always clears the channel and re-posts, so in-memory state is sufficient.
- Squad RCON integration, vote tally surfacing, or other live game state.
- Heartbeat re-posts. Posts happen on change only.
- Server.cfg validation beyond the `MapRotationMode` line.

## Design

### Files

```
src/services/layerRotationValidator/
  layerRotationValidatorService.js     # SFTP fetch, cfg parsing, API call
  layerRotationValidatorEmbeds.js      # embed builders, layer-token prettifier, column formatter
  layerRotationValidatorScheduler.js   # interval loop, channel-clear, message lifecycle, role-pinged error post
```

Wired in `src/index.js` next to `configGuardianScheduler.startScheduler(client)`.

### Per-tick flow

1. **Open SFTP connection.** Reuse the same env vars as `ConfigGuardian` (`SFTP_HOST`, `SFTP_PORT`, `SFTP_USER`, `SFTP_PASS`, `SFTP_PATH`). One connection per tick, closed in `finally`.
2. **Fetch `Server.cfg`.** Try `Server.cfg` first; if `sftp.get` throws "No such file", retry with `server.cfg`. Cache the resolved casing for subsequent ticks so we don't double-fetch.
3. **Parse `Server.cfg`** for the first uncommented line matching `^\s*MapRotationMode\s*=\s*(\S+)\s*$`. Comments are `//` or `#` at the line start (whitespace allowed before).
   - If mode is not `LayerList` or `LayerList_Vote`: log a warning at info level (`{ mode }`), close the SFTP connection, return. The live embed in prod is left untouched.
4. **Fetch `LayerRotation.cfg`** as UTF-8 text. Trim trailing whitespace per line. Drop blank lines and `//` / `#` comment lines. Keep the cleaned text and an array of layer-tokens.
5. **Compute change hash.** SHA-1 of `${mode}\n${cleanedLayerRotationText}`. If the hash matches `lastValidHash` (in-memory), skip the API call and the post — the rotation hasn't changed since the last successful validation. Close SFTP and return.
6. **Call squadutils.org parser API.** `POST ${SQUAD_UTILS_URL}` (default `https://squadutils.org/api/v3/parse`) with JSON body `{ rotation: <cleaned text> }`. Timeout 15s via `AbortController`.
   - Accept HTTP `200` and `422` as parseable responses (Python bot precedent).
   - On other status / network failure: log error, do **not** repost the embed or alert (avoid flapping). Errors during validation are not the same as rotation errors.
7. **Branch on `response.errors`:**
   - **Errors present** → call `postRotationError(client, errors)` (see below). Do not advance `lastValidHash`.
   - **No errors** → call `replaceLiveEmbed(client, { mode, layers })`. Update `lastValidHash`.

### Live-embed lifecycle (prod channel `1509632566548889773`)

State held in-module:
```js
let liveMessageId = null;
let lastValidHash = null;
```

On scheduler **start** (before the first tick):
- Fetch up to 100 most recent messages in the channel.
- Call `channel.bulkDelete(messages, true)` (discord.js handles messages <14 days old; `true` filters older ones silently).
- For anything left from the fetch (older than 14 days), delete individually with a `.catch(() => {})` per message. Bounded by the 100 we fetched — no pagination loop.
- This is an aggressive clear of bot **and** human messages because the channel is a single-purpose status surface (user-confirmed). The bulk-delete is bounded and one-shot at boot.

On each successful change post:
- `channel.send({ embeds: [embed] })` → capture new message id.
- If `liveMessageId` was set, delete that previous message (best-effort, `.catch(() => {})`).
- Store the new id as `liveMessageId`.

Order is **send → delete old**, so the channel is never empty between transitions.

### Error post (alerts channel `1423733551257489501`)

`errorAlertService.reportError` only sends embeds (no `content` field, no `allowedMentions`), so rotation errors post directly to the alerts channel with our own payload — bypassing the dedupe/edit machinery. Rotation breakage is infrequent and you want it loud.

Behavior:

- `channel.send({ content, embeds: [embed], allowedMentions: { roles: ['1225894972084060290', '733974178797191189'] } })`
- `content` is `<@&1225894972084060290> <@&733974178797191189> Layer rotation failed validation`.
- Embed is red (`0xED4245`), title `Layer rotation has errors`, description summarises `<N>` errors with the line/content/error of each (truncated per Discord field limits, identical format to the Python bot's:
  `Line <N>: <content> - <error>`).
- Module-level dedupe: track `lastErrorHash` (SHA-1 of the sorted error list). If unchanged from the previous tick, skip — the next change in either the rotation OR the error set triggers a new post.

The error post does **not** touch `liveMessageId`. The last known-good embed stays visible in the prod channel until a new valid rotation is fetched.

### Squad layer parser & embed renderer (`layerRotationValidatorEmbeds.js`)

Input: array of cfg-line strings like `FoolsRoad_RAAS_v1 AFU RGF`.

Per line:
1. Split on whitespace: `[layerToken, team1?, team2?]`.
2. Tokenize `layerToken` on `_`: e.g. `FoolsRoad_RAAS_v1` → `[FoolsRoad, RAAS, v1]`.
3. The **mode token** is the second-to-last segment when the last segment matches `/^v\d+$/`. Otherwise the last segment is the mode and version is empty.
4. The **map token** is the join of everything before the mode segment.
5. Prettify the map name: insert a space before every uppercase letter except the first (`FoolsRoad` → `Fools Road`, `BlackCoast` → `Black Coast`, `GooseBay` → `Goose Bay`). Single-word map names (`Sumari`, `Mestia`, `Chora`, `Tallil`, `Kohat`, `Narva`, `Kokan`, `Mutaha`, `Lashkar`, `Sanxian`, `Harju`, `Yehorivka`, `Fallujah`, `Gorodok`, `Skorpo`, `Manicouagan`) pass through unchanged.
6. Format teams: split on `+` → join with ` + `. Missing team → `-`.
7. If the line doesn't conform to the `Map_Mode[_vN]` shape, fall back to rendering the raw `layerToken` in the Map column with empty Variant. Faction tokens still rendered if present.

The embed body is a single fenced code block with a 5-column table (`#`, `Map`, `Variant`, `Team 1`, `Team 2`). Column widths are computed from the data so the table stays aligned. With ~22 layers in the current rotation and reasonable name widths, the body is well under Discord's 4096-char description limit; no fallback rendering needed.

Embed shape (success):

```
Title:       Royal Battalion - Layer Rotation
Description: Mode: <mode label>  |  <N> layers  |  Updated <t:unix:R>
             ```<table>```
Footer:      Validated via squadutils.org
Color:       0x57F287 (green)
Timestamp:   now
```

Mode label is `LayerList` or `LayerList_Vote (players vote)`.

### Config

`settings.production.js` adds:
```js
layerRotationValidator: {
  enabled: true,
  channelId: '1509632566548889773',
  errorRoleIds: ['1225894972084060290', '733974178797191189'],
  intervalMs: 5 * 60 * 1000,
  squadUtilsUrl: process.env.SQUAD_UTILS_URL || 'https://squadutils.org/api/v3/parse',
  serverCfgName: 'Server.cfg',           // fallback: server.cfg
  layerRotationName: 'LayerRotation.cfg',
}
```

`settings.development.js` and `settings.staging.js`:
```js
layerRotationValidator: { enabled: false }
```

`startScheduler` in `index.js` exits early when `enabled !== true` or `channelId` is missing. SFTP env-var validation reuses the same "warn + disable" pattern as `ConfigGuardian`.

### Logging

Per `CLAUDE.md` convention — Pino child logger `{ module: 'layerRotationValidator' }`. Levels:
- `info` on start, on each successful post (with mode + layer count + change reason), on each error post.
- `warn` for "mode is not LayerList[_Vote]" and "API returned non-200/422" (rate-limited via `lastWarnMode` to avoid spam).
- `error` for SFTP / Discord exceptions caught in the tick wrapper.

### Failure & edge-case matrix

| Condition | Behavior |
|---|---|
| SFTP file missing on first ever boot | Log warn, skip tick, next tick retries. No alert. |
| Both Server.cfg and server.cfg missing | Log error once via `reportError` (severity `error`), keep skipping ticks. |
| `MapRotationMode` line missing or commented out | Log warn `{ mode: null }`, do nothing visible. |
| Mode = `Random` / `LevelList` / unknown | Log warn `{ mode }`, do nothing visible. |
| API timeout (>15s) | Log warn, do not change embed, do not post error. |
| API returns HTTP 5xx | Same as timeout. |
| Discord `bulkDelete` permission denied on boot | Log warn, continue (live embed will still post; old messages will persist visually). |
| Discord `send` fails | Log error via `reportError(severity: 'fatal')`. Do not advance `lastValidHash` so next tick retries. |
| `liveMessageId` delete fails | Log warn, leave the stale embed. Next change will retry. |
| Rotation valid but identical to last post | No-op (hash match), no SFTP read beyond what already happened. |

### Tests

Unit-testable bits in `layerRotationValidatorService.js` and `layerRotationValidatorEmbeds.js`:
- `parseMapRotationMode(cfgText)` — exhaustive over: line present, line commented with `//`, line commented with `#`, line with surrounding whitespace, multiple `MapRotationMode` lines (first uncommented wins), missing line, unknown mode value.
- `parseLayerRotation(cfgText)` — comment/blank-line stripping, trailing whitespace, CRLF/LF mix.
- `prettifyLayerToken(token)` — CamelCase map names, multi-word modes, missing version, malformed input.
- `formatRotationTable(layers)` — column alignment, single-team rows, missing teams.

The SFTP, Discord, and HTTP boundaries stay as thin orchestration — not unit-tested. Smoke-test by running the bot in dev with `enabled: true` pointed at a sandbox channel.

## Non-goals (explicit)

- No new MariaDB table.
- No webhook out of the service.
- No refactor of `ConfigGuardian`.
- No rebroadcast of the embed to staging/dev channels.
- No daily heartbeat (changed during brainstorming — user wants change-only).
- No deletion-of-bot-messages-only mode (user wants the whole channel cleared).

## Dependencies

- `ssh2-sftp-client` (already in `package.json`).
- `discord.js` (already in `package.json`).
- Built-in `fetch` (Bun/Node 18+) for the squadutils.org call. No new dependency.
- `crypto.createHash` for SHA-1 change hashing.
