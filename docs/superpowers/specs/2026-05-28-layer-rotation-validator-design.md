# Layer Rotation Validator

## Goal

Maintain a single live embed in channel `1509632566548889773` showing the Squad server's current layer rotation, validated against the squadutils.org parser API. The rotation source is selectable via env var:

- **SFTP mode (default)** — every 5 minutes, fetch `Server.cfg` and `LayerRotation.cfg` from SFTP and validate.
- **Channel mode** — listen for cfg-text messages posted by authorised admins in the live-embed channel; validate, persist, render. Server.cfg is still polled every 5 min for the mode badge only.

In both modes:

- The live embed updates only when the rotation or active mode actually changes.
- When validation returns errors in SFTP mode, a single alert (with role pings to `1225894972084060290` and `733974178797191189`) is posted to alerts channel `1423733551257489501`. The live embed is not touched.
- When validation returns errors in Channel mode, the poster's message gets a ❌ reaction and is deleted after 30 s. No alerts-channel post (the poster is right there).
- When the active rotation mode is anything other than `LayerList` or `LayerList_Vote`, no embed change is made. Log a warning.
- The live-embed channel is bot-only: any human message gets deleted. In Channel mode the deletion happens after the authorisation + validation pipeline.

This ports the `parseMapRotation` capability from the Python bot (`Royal-secretary-discord-bot/royal_secretary/externalAPI.py`) — which only validated user-typed rotations in a Discord channel — and unifies it with an automated SFTP source-of-truth path.

## Scope

In scope:

- New service `src/services/layerRotationValidator/` with its own scheduler (5-minute interval, reusing `createScheduler`).
- Two operating modes selected by env var `LAYER_ROTATION_SOURCE` (`sftp` default, or `channel`).
- New SFTP fetch path (only the relevant cfg files), independent of `ConfigGuardian`.
- New embed builder with a Squad layer-token prettifier.
- Aggressive channel clear on boot followed by re-post of the last persisted rotation (the prod channel is treated as a single-purpose status surface; the DB row survives restarts so the channel is rarely empty after a deploy).
- New env var `SQUAD_UTILS_URL` (matches the Python bot's env name).
- New env var `LAYER_ROTATION_SOURCE` (mode selector).
- New settings block per environment (`enabled` + `channelId` + `errorRoleIds` so dev/staging are disabled by default).
- New `Events.MessageCreate` hook scoped to the prod channel that:
  - Deletes any human message in SFTP mode (silent bot-only invariant).
  - In Channel mode: deletes messages from non-authorised authors, validates messages from `errorRoleIds`-holding authors, and updates the live embed on success.
- New single-row MariaDB table `layer_rotation_current` to persist the last valid rotation, mode, and source across restarts.

Out of scope:

- Reworking or coupling to `ConfigGuardian`. The two services share SFTP credentials but nothing else.
- Squad RCON integration, vote tally surfacing, or other live game state.
- Heartbeat re-posts. Posts happen on change only.
- Server.cfg validation beyond the `MapRotationMode` line.
- A separate input channel in Channel mode — posts and the live embed share channel `1509632566548889773`.
- Switching modes at runtime — `LAYER_ROTATION_SOURCE` is read at boot; restart required to flip.

## Design

### Files

```
src/services/layerRotationValidator/
  layerRotationValidatorService.js     # SFTP fetch, cfg parsing, API call, DB persistence
  layerRotationValidatorEmbeds.js      # embed builders, layer-token prettifier, column formatter
  layerRotationValidatorScheduler.js   # interval loop, channel-clear, message lifecycle, role-pinged error post
  layerRotationChannelHandler.js       # MessageCreate hook: auth check, validate, delete, render
```

- Scheduler `startScheduler(client)` is wired in `src/events/ready.js` (the ClientReady chain — `src/index.js` only handles shutdown).
- `layerRotationChannelHandler.handleMessage(message)` is invoked from `src/events/messageCreate.js` at the top of the `execute` function, before the bot-author short-circuit. The handler returns `true` if it owned the message so `messageCreate` short-circuits further processing.

### Operating modes

The scheduler reads `process.env.LAYER_ROTATION_SOURCE` at start. `'channel'` activates Channel mode; anything else (including unset) is SFTP mode. Mode is logged once on start.

### Per-tick flow — SFTP mode

1. **Open SFTP connection.** Reuse the same env vars as `ConfigGuardian` (`SFTP_HOST`, `SFTP_PORT`, `SFTP_USER`, `SFTP_PASS`, `SFTP_PATH`). One connection per tick, closed in `finally`.
2. **Fetch `Server.cfg`.** Try `Server.cfg` first; if `sftp.get` throws "No such file", retry with `server.cfg`. Cache the resolved casing for subsequent ticks so we don't double-fetch.
3. **Parse `Server.cfg`** for the first uncommented line matching `^\s*MapRotationMode\s*=\s*(\S+)\s*$`. Comments are `//` or `#` at the line start (whitespace allowed before).
   - If mode is not `LayerList` or `LayerList_Vote`: log a warning at info level (`{ mode }`), close the SFTP connection, return. The live embed is left untouched.
4. **Fetch `LayerRotation.cfg`** as UTF-8 text. Trim trailing whitespace per line. Drop blank lines and `//` / `#` comment lines. Keep the cleaned text and an array of layer-tokens.
5. **Compute change hash.** SHA-1 of `${mode}\n${cleanedLayerRotationText}`. If the hash matches `lastValidHash` (in-memory), skip the API call and the post. Close SFTP and return.
6. **Call squadutils.org parser API.** `POST ${SQUAD_UTILS_URL}` (default `https://squadutils.org/api/v3/parse`) with JSON body `{ rotation: <cleaned text> }`. Timeout 15s via `AbortController`.
   - Accept HTTP `200` and `422` as parseable responses (Python bot precedent).
   - On other status / network failure: log warn, do **not** repost the embed or alert (avoid flapping).
7. **Branch on `response.errors`:**
   - **Errors present** → call `postRotationError(client, errors)` (alerts channel, role pings). Do not advance `lastValidHash`.
   - **No errors** → call `replaceLiveEmbed(client, { mode, lines, source: 'sftp' })`. Update `lastValidHash`. Upsert the persisted row.

### Per-tick flow — Channel mode

1. **Open SFTP connection** for Server.cfg only.
2. **Fetch + parse Server.cfg** as above. Cache the parsed mode in module state (`lastKnownMode`). On SFTP failure, log warn and keep using the previously cached mode (or `null` if never fetched).
3. **If the parsed mode differs from the mode embedded in the current live embed** AND we have a cached rotation row, re-render the embed with the new mode badge. Updates the persisted row's `mode`. No squadutils call needed (the layer list itself didn't change).
4. **No new rotation posts happen on the tick** — Channel mode is event-driven. All new rotations enter via the message handler.

### Channel mode message handling (`layerRotationChannelHandler.handleMessage`)

Invoked from `messageCreate.js` before the bot-author short-circuit. Steps:

1. **Filter.** Returns `false` (not handled) if any are true: no guild, channel id ≠ prod channel id, no settings block. The caller continues normal routing.
2. **Bot author.** If `message.author.bot` → returns `true` (handled, do nothing). Our own embed posts must pass through.
3. **Mode = `sftp`.** Delete the message silently. Return `true`.
4. **Mode = `channel`. Authorisation check.** Fetch the member's roles. If they hold neither `errorRoleIds[0]` nor `errorRoleIds[1]`: delete the message immediately, log info `{ userId }`, return `true`.
5. **Authorised path.** Treat the entire `message.content` as raw cfg text. Run through `parseLayerRotation` (same parser as SFTP mode — handles `//` / `#` comments, blank lines, CRLF).
6. **Call squadutils.org parser API.** Same 15s timeout, same 200/422 acceptance.
   - **Network/HTTP failure (not a parser error)** → react ❌, schedule deletion in 30s, log warn. Return `true`.
   - **API returned parser errors** → react ❌, schedule deletion in 30s. Return `true`. *(No alerts-channel post in Channel mode — the poster is right there.)*
   - **Valid (no errors)** → compute change hash (`mode + cleanedText`). If hash equals `lastValidHash`: delete user message, no embed change, return `true` (silent no-op for duplicate posts). Otherwise: delete user message, call `replaceLiveEmbed(client, { mode: lastKnownMode || 'Unknown', lines, source: 'channel' })`, update `lastValidHash`, upsert persisted row, return `true`.

The ❌ reaction + 30s delete pattern is implemented with `setTimeout(() => message.delete().catch(() => {}), 30_000)` and `message.react('❌').catch(() => {})`.

### Live-embed lifecycle (prod channel `1509632566548889773`)

State held in-module:
```js
let liveMessageId = null;
let lastValidHash = null;
let lastErrorHash = null;
let lastKnownMode = null;
```

On scheduler **start** (before the first tick):
- Read persisted row from MariaDB (if any).
- Fetch up to 100 most recent messages in the channel.
- Call `channel.bulkDelete(messages, true)` (discord.js handles messages <14 days old; `true` filters older ones silently).
- For anything left from the fetch (older than 14 days), delete individually with a `.catch(() => {})` per message. Bounded by the 100 we fetched — no pagination loop.
- This is an aggressive clear of bot **and** human messages because the channel is a single-purpose status surface (user-confirmed). The bulk-delete is bounded and one-shot at boot.
- If a persisted row exists: post a re-render embed with `{ mode, lines, source }` from the row. Set `liveMessageId` to the new id. Recompute and store `lastValidHash` from the persisted row.

On each successful change post:
- `channel.send({ embeds: [embed] })` → capture new message id.
- If `liveMessageId` was set, delete that previous message (best-effort, `.catch(() => {})`).
- Store the new id as `liveMessageId`.
- Upsert the persisted row.

Order is **send → delete old**, so the channel is never empty between transitions.

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

### Persistence

New MariaDB table in the `secretary` pool:

```sql
CREATE TABLE IF NOT EXISTS layer_rotation_current (
  id TINYINT UNSIGNED NOT NULL DEFAULT 1 PRIMARY KEY,
  cleaned_text TEXT NOT NULL,
  mode VARCHAR(32) NOT NULL,
  source ENUM('sftp','channel') NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

Single-row table — `id` is always `1`. Upsert pattern: `INSERT ... ON DUPLICATE KEY UPDATE`. Read with `SELECT cleaned_text, mode, source FROM layer_rotation_current WHERE id = 1 LIMIT 1`. Created in `src/database/schema.js`'s `initSchema()` alongside existing tables.

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

`startScheduler` (called from `ready.js`) exits early when `enabled !== true` or `channelId` is missing. SFTP env-var validation reuses the same "warn + disable" pattern as `ConfigGuardian`.

**Env vars consumed by the scheduler at boot:**
- `LAYER_ROTATION_SOURCE` — `sftp` (default) or `channel`. Anything else logs warn and falls back to `sftp`.
- `SQUAD_UTILS_URL` — overrides the default `https://squadutils.org/api/v3/parse`.
- `SFTP_HOST` / `SFTP_PORT` / `SFTP_USER` / `SFTP_PASS` / `SFTP_PATH` — needed in both modes (Channel mode still needs Server.cfg for the mode badge). If absent in Channel mode, the embed renders with mode `Unknown` and a warn is logged.

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
| Channel mode: SFTP unavailable for Server.cfg | Embed renders with mode label `Unknown`. Subsequent ticks retry. |
| Channel mode: message from unauthorised author | Silent delete, log info `{ userId }`. No reaction. |
| Channel mode: message in invalid cfg format (parser errors) | React ❌, schedule delete in 30s. No alerts-channel post. |
| Channel mode: authorised user posts a rotation matching the current hash | Delete user message, no embed change. |
| Channel mode: bot lacks Manage Messages perm | Deletes silently fail (caught), embed still posts/updates. Warn logged. |
| SFTP mode: any human message in the prod channel | Silent delete. |
| Persisted row missing on boot | Channel is cleared, no embed posted, scheduler waits for next tick (SFTP) or message (Channel). |
| Persisted row present but corrupt JSON / non-string text | Log error, fall back to empty state (as if no row). |

### Tests

Unit-testable bits in `layerRotationValidatorService.js` and `layerRotationValidatorEmbeds.js`:
- `parseMapRotationMode(cfgText)` — exhaustive over: line present, line commented with `//`, line commented with `#`, line with surrounding whitespace, multiple `MapRotationMode` lines (first uncommented wins), missing line, unknown mode value.
- `parseLayerRotation(cfgText)` — comment/blank-line stripping, trailing whitespace, CRLF/LF mix.
- `prettifyLayerToken(token)` — CamelCase map names, multi-word modes, missing version, malformed input.
- `formatRotationTable(layers)` — column alignment, single-team rows, missing teams.

The SFTP, Discord, and HTTP boundaries stay as thin orchestration — not unit-tested. Smoke-test by running the bot in dev with `enabled: true` pointed at a sandbox channel.

## Non-goals (explicit)

- No webhook out of the service.
- No refactor of `ConfigGuardian`.
- No rebroadcast of the embed to staging/dev channels.
- No daily heartbeat (changed during brainstorming — user wants change-only).
- No deletion-of-bot-messages-only mode (user wants the whole channel cleared on boot).
- No separate input channel in Channel mode.
- No runtime mode switching — restart required to flip `LAYER_ROTATION_SOURCE`.
- No DM-based feedback to rejected posters.
- No history table for past rotations — only the current one is persisted (`id=1` upsert).

## Dependencies

- `ssh2-sftp-client` (already in `package.json`).
- `discord.js` (already in `package.json`).
- Built-in `fetch` (Bun/Node 18+) for the squadutils.org call. No new dependency.
- `crypto.createHash` for SHA-1 change hashing.
