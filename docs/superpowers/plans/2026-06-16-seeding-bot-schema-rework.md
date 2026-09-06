# Seeding Bot + Schema Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the two server-identity bugs (announcer reads the wrong server; tracker rewards seeding on any server) and consolidate all seeding config into the DB, in the `RoyalSecretaryDiscordBot` bot + its schema, without changing the SquadJS pipeline.

**Architecture:** Server identity becomes the canonical `squadjs_servers.id` (an integer). `SQUADJS_SERVERS` env entries carry that id (`name|url|token|serverId`); the bot maps each socket connection to its id. The announcer resolves a configured `announcer_server_id` to a live socket (no silent fallback — unresolved/disconnected = an explicit "unavailable" state). The tracker filters every `squadjs_seed_sessions` query by a configured `tracker_server_id`. All editable config moves to the `seeding_config` DB row; the bot also writes a `seeding_live_status` row each monitor tick for the website to read. The risky decision logic (server resolution, env parsing, reward decision) is extracted into pure helpers and unit-tested with `bun:test`.

**Tech Stack:** Bun, discord.js v14, MariaDB (`mariadb` pool), socket.io-client, Pino, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-06-16-seeding-system-rework-design.md`

**Out of scope (Plan B):** all `RoyalBattalionWebpage` changes (the new `/seeding` page, server dropdown, server_id filters on the website API routes, redirect). Plan B depends on this plan's schema being live.

---

## File Structure

**New files:**
- `src/config/parseSquadJsServers.js` — pure parser for the `SQUADJS_SERVERS` env string (now 4 fields). Extracted from `config.js` so it can be unit-tested.
- `src/config/__tests__/parseSquadJsServers.test.js` — tests for the parser.
- `src/services/seeding/serverResolver.js` — pure `pickServerStateById(entries, serverId)` + `coerceServerId(value)`.
- `src/services/seeding/__tests__/serverResolver.test.js` — tests.
- `src/services/seedTracker/seederRewardLogic.js` — pure `decideSeederAction({...})`.
- `src/services/seedTracker/__tests__/seederRewardLogic.test.js` — tests.

**Modified files:**
- `src/config/parseSquadJsServers.js` is imported by `src/config.js:12-18`.
- `src/database/schema.js:201-257` — add `seeding_config` columns + `seeding_live_status` table + backfill.
- `src/services/seeding/seedingSocket.js` — record `serverId` per connection; add `getServerStateById`; delete the silent first-connection fallback; add `setAnnouncerServerId`/`getAnnouncerServerId`.
- `src/services/seeding/seedingService.js` — extend `getSeedingConfig` (new columns + `role_ids` parse + tracker defaults); add `writeLiveStatus`/`getLiveStatus`; add `server_id` filter to `getSeedingRapport`.
- `src/services/seeding/seedingScheduler.js` — resolve `announcer_server_id`; ping `role_ids`; "unavailable" handling; write live status each tick; push `announcer_server_id` into the socket module.
- `src/services/seeding/seedingEmbeds.js` — `buildSeedingCallEmbed` renders "unavailable" when `playerCount == null`.
- `src/services/seedTracker/seedTrackerService.js` — `server_id` filter on all three queries; read config from DB; use `decideSeederAction`; dynamic durations.
- `src/services/seedTracker/seedTrackerScheduler.js` — read config from DB instead of `config.seedTracker`.
- `src/services/seedTracker/seedTrackerEmbeds.js` — dynamic duration in grant/DM embeds.
- `settings.production.js` / `settings.staging.js` / `settings.development.js` — drop `seedingServer` + the standalone `seedTracker` block; keep/extend a single `seeding` defaults block.
- `src/index.js:46-68` — boot log uses DB `announcer_server_id`/`tracker_server_id`.
- `.env.example` — document `SQUADJS_SERVERS=name|url|token|serverId`.
- `package.json:3` — version bump.

---

## Task 1: Schema — add seeding_config columns + seeding_live_status table

**Files:**
- Modify: `src/database/schema.js` (after line 257, inside the "Seeding migrations" block)

- [ ] **Step 1: Add the new columns and table.** In `src/database/schema.js`, immediately after the existing line `await query(`ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS last_reset_date DATE NULL`);` (currently line 257), insert:

```javascript
  // Seeding rework (2026-06-16): server-id identity + consolidated tracker config
  await query(`ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS role_ids JSON NULL`);
  await query(`ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS announcer_server_id INT NULL`);
  await query(`ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS tracker_server_id INT NULL`);
  await query(`ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS tracker_enabled TINYINT(1) DEFAULT 0`);
  await query(`ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS required_seed_days INT DEFAULT 10`);
  await query(`ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS rolling_window_days INT DEFAULT 30`);
  await query(`ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS whitelist_duration_days INT DEFAULT 30`);
  await query(`ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS max_extension_days INT DEFAULT 60`);
  await query(`ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS progression_channel_id VARCHAR(20) NULL`);
  await query(`ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS leaderboard_channel_id VARCHAR(20) NULL`);

  // Backfill role_ids from the legacy single role_id (only when role_ids is still null)
  await query(`UPDATE seeding_config SET role_ids = JSON_ARRAY(role_id) WHERE role_ids IS NULL AND role_id IS NOT NULL AND role_id <> ''`);

  await query(`
    CREATE TABLE IF NOT EXISTS seeding_live_status (
      id INT PRIMARY KEY DEFAULT 1,
      server_resolved_ok TINYINT(1) DEFAULT 0,
      socket_connected TINYINT(1) DEFAULT 0,
      current_population INT NULL,
      current_layer VARCHAR(200) NULL,
      active_session_id INT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CHECK (id = 1)
    )
  `);
```

- [ ] **Step 2: Verify it loads.** Run: `bun -e "import('./src/database/schema.js').then(m => console.log(typeof m.initSchema))"`
Expected: prints `function` with no syntax error. (This only checks the module parses; the migration itself runs against the DB at boot.)

- [ ] **Step 3: Commit.**

```bash
git add src/database/schema.js
git commit -m "feat(seeding): add server-id + consolidated tracker columns and live-status table"
```

---

## Task 2: Pure env parser with serverId (TDD)

**Files:**
- Create: `src/config/parseSquadJsServers.js`
- Test: `src/config/__tests__/parseSquadJsServers.test.js`
- Modify: `src/config.js:12-18, 39`

- [ ] **Step 1: Write the failing test.** Create `src/config/__tests__/parseSquadJsServers.test.js`:

```javascript
import { describe, test, expect } from 'bun:test';
import { parseSquadJsServers } from '../parseSquadJsServers.js';

describe('parseSquadJsServers', () => {
  test('returns [] for empty/undefined input', () => {
    expect(parseSquadJsServers('')).toEqual([]);
    expect(parseSquadJsServers(undefined)).toEqual([]);
  });

  test('parses a single 4-field entry into name/url/token/serverId', () => {
    expect(parseSquadJsServers('main|ws://h:4000|tok|1')).toEqual([
      { name: 'main', url: 'ws://h:4000', token: 'tok', serverId: 1 },
    ]);
  });

  test('serverId is null when the 4th field is missing or blank', () => {
    expect(parseSquadJsServers('main|ws://h:4000|tok')[0].serverId).toBeNull();
    expect(parseSquadJsServers('main|ws://h:4000|tok|')[0].serverId).toBeNull();
  });

  test('parses multiple comma-separated entries and trims whitespace', () => {
    const result = parseSquadJsServers(' main|ws://a|t1|1 , battle|ws://b|t2|2 ');
    expect(result).toEqual([
      { name: 'main', url: 'ws://a', token: 't1', serverId: 1 },
      { name: 'battle', url: 'ws://b', token: 't2', serverId: 2 },
    ]);
  });

  test('non-numeric serverId becomes null (never NaN)', () => {
    expect(parseSquadJsServers('main|ws://h|tok|abc')[0].serverId).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails.** Run: `bun test src/config/__tests__/parseSquadJsServers.test.js`
Expected: FAIL — `Cannot find module '../parseSquadJsServers.js'`.

- [ ] **Step 3: Implement the parser.** Create `src/config/parseSquadJsServers.js`:

```javascript
// Parses the SQUADJS_SERVERS env string. Format per entry: name|url|token|serverId
// (serverId is the canonical squadjs_servers.id). Comma-separated for multiple servers.
export function parseSquadJsServers(envStr) {
  if (!envStr) return [];
  return envStr.split(',').map((entry) => {
    const [name, url, token, serverIdRaw] = entry.trim().split('|');
    const parsed = serverIdRaw != null && serverIdRaw.trim() !== '' ? Number(serverIdRaw) : null;
    const serverId = Number.isFinite(parsed) ? parsed : null;
    return { name, url, token, serverId };
  });
}
```

- [ ] **Step 4: Run it to verify it passes.** Run: `bun test src/config/__tests__/parseSquadJsServers.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire it into config.js.** In `src/config.js`, delete the inline `parseSquadJsServers` function (lines 12-18) and add an import at the top (after line 1):

```javascript
import { parseSquadJsServers } from './config/parseSquadJsServers.js';
```

The existing `squadjs: parseSquadJsServers(process.env.SQUADJS_SERVERS),` on line 39 now resolves to the imported function — no other change.

- [ ] **Step 6: Verify config still loads.** Run: `bun -e "import('./src/config.js').then(m => console.log(Array.isArray(m.default.squadjs)))"`
Expected: prints `true`.

- [ ] **Step 7: Commit.**

```bash
git add src/config/parseSquadJsServers.js src/config/__tests__/parseSquadJsServers.test.js src/config.js
git commit -m "feat(seeding): parse server_id from SQUADJS_SERVERS env"
```

---

## Task 3: Pure server-resolution helper (TDD)

**Files:**
- Create: `src/services/seeding/serverResolver.js`
- Test: `src/services/seeding/__tests__/serverResolver.test.js`

- [ ] **Step 1: Write the failing test.** Create `src/services/seeding/__tests__/serverResolver.test.js`:

```javascript
import { describe, test, expect } from 'bun:test';
import { pickServerStateById, coerceServerId } from '../serverResolver.js';

describe('coerceServerId', () => {
  test('passes through positive integers', () => {
    expect(coerceServerId(1)).toBe(1);
    expect(coerceServerId('2')).toBe(2);
  });
  test('returns null for null/blank/non-numeric', () => {
    expect(coerceServerId(null)).toBeNull();
    expect(coerceServerId('')).toBeNull();
    expect(coerceServerId('abc')).toBeNull();
  });
});

describe('pickServerStateById', () => {
  const entries = [
    { serverId: 1, state: { connected: true, playerCount: 12 } },
    { serverId: 2, state: { connected: true, playerCount: 80 } },
  ];

  test('returns the state whose serverId matches', () => {
    expect(pickServerStateById(entries, 2).playerCount).toBe(80);
  });

  test('returns null when serverId is null (no silent fallback)', () => {
    expect(pickServerStateById(entries, null)).toBeNull();
  });

  test('returns null when no entry matches (no silent fallback)', () => {
    expect(pickServerStateById(entries, 99)).toBeNull();
  });

  test('returns null for an empty connection set', () => {
    expect(pickServerStateById([], 1)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails.** Run: `bun test src/services/seeding/__tests__/serverResolver.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement.** Create `src/services/seeding/serverResolver.js`:

```javascript
// Pure helpers for resolving the canonical squadjs_servers.id to a live socket
// connection. There is intentionally NO fallback to "first connection" — an
// unresolved id returns null so callers surface an explicit "unavailable" state.

export function coerceServerId(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

/**
 * @param {Array<{serverId: number|null, state: object}>} entries
 * @param {number|null} serverId
 * @returns {object|null} the matching connection state, or null
 */
export function pickServerStateById(entries, serverId) {
  const target = coerceServerId(serverId);
  if (target == null) return null;
  const match = entries.find((e) => coerceServerId(e.serverId) === target);
  return match ? match.state : null;
}
```

- [ ] **Step 4: Run it to verify it passes.** Run: `bun test src/services/seeding/__tests__/serverResolver.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/services/seeding/serverResolver.js src/services/seeding/__tests__/serverResolver.test.js
git commit -m "feat(seeding): add pure server-id resolution helper (no fallback)"
```

---

## Task 4: Pure reward-decision helper (TDD)

**Files:**
- Create: `src/services/seedTracker/seederRewardLogic.js`
- Test: `src/services/seedTracker/__tests__/seederRewardLogic.test.js`

This extracts the exact branching currently inline in `seedTrackerService.processCompletedSession` (`seedTrackerService.js:144-173`) into a pure function.

- [ ] **Step 1: Write the failing test.** Create `src/services/seedTracker/__tests__/seederRewardLogic.test.js`:

```javascript
import { describe, test, expect } from 'bun:test';
import { decideSeederAction } from '../seederRewardLogic.js';

const DAY = 86400000;
const NOW = 1_700_000_000_000; // fixed reference instant
const base = { requiredDays: 10, durationDays: 30, maxExtensionDays: 60, nowMs: NOW };

describe('decideSeederAction', () => {
  test('non-Seeder whitelist is always skipped', () => {
    const r = decideSeederAction({ ...base, uniqueDays: 99, whitelist: { role: 'Admin', expiresAt: null } });
    expect(r.action).toBe('skip');
  });

  test('no whitelist + below threshold = progression', () => {
    const r = decideSeederAction({ ...base, uniqueDays: 4, whitelist: null });
    expect(r.action).toBe('progression');
  });

  test('no whitelist + at threshold = grant', () => {
    const r = decideSeederAction({ ...base, uniqueDays: 10, whitelist: null });
    expect(r.action).toBe('grant');
  });

  test('Seeder whitelist below threshold = skip (no extension)', () => {
    const wl = { role: 'Seeder', expiresAt: new Date(NOW + 5 * DAY) };
    expect(decideSeederAction({ ...base, uniqueDays: 9, whitelist: wl }).action).toBe('skip');
  });

  test('Seeder whitelist at threshold extends by durationDays', () => {
    const wl = { role: 'Seeder', expiresAt: new Date(NOW + 5 * DAY) };
    const r = decideSeederAction({ ...base, uniqueDays: 10, whitelist: wl });
    expect(r.action).toBe('extend');
    expect(r.expiresAt.getTime()).toBe(NOW + 30 * DAY);
  });

  test('extension is capped at maxExtensionDays from now', () => {
    // current expiry already far out; new 30d expiry would exceed the 60d cap only if base were larger,
    // so test the cap directly with a long duration
    const wl = { role: 'Seeder', expiresAt: new Date(NOW + 5 * DAY) };
    const r = decideSeederAction({ ...base, durationDays: 90, uniqueDays: 10, whitelist: wl });
    expect(r.action).toBe('extend');
    expect(r.expiresAt.getTime()).toBe(NOW + 60 * DAY); // capped
  });

  test('does not shorten an expiry that is already later than the new one', () => {
    const wl = { role: 'Seeder', expiresAt: new Date(NOW + 50 * DAY) };
    const r = decideSeederAction({ ...base, uniqueDays: 10, whitelist: wl });
    expect(r.action).toBe('skip');
  });
});
```

- [ ] **Step 2: Run it to verify it fails.** Run: `bun test src/services/seedTracker/__tests__/seederRewardLogic.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement.** Create `src/services/seedTracker/seederRewardLogic.js`:

```javascript
const DAY_MS = 86400000;

/**
 * Decide what to do for a player after a completed seed session. Pure — no I/O.
 * @param {object} p
 * @param {number} p.uniqueDays      distinct seed days in the rolling window
 * @param {number} p.requiredDays    threshold to earn/renew
 * @param {{role: string, expiresAt: (Date|string|null)}|null} p.whitelist
 * @param {number} p.durationDays    grant/renewal length
 * @param {number} p.maxExtensionDays cap measured from now
 * @param {number} p.nowMs           current epoch ms (injected for testability)
 * @returns {{action: 'skip'|'progression'|'grant'|'extend', expiresAt?: Date}}
 */
export function decideSeederAction({ uniqueDays, requiredDays, whitelist, durationDays, maxExtensionDays, nowMs }) {
  // Any active non-Seeder whitelist (clan, admin, etc.) takes precedence — never touch it.
  if (whitelist && whitelist.role !== 'Seeder') return { action: 'skip' };

  const earned = uniqueDays >= requiredDays;

  if (whitelist && whitelist.role === 'Seeder') {
    if (!earned) return { action: 'skip' };
    const maxMs = nowMs + maxExtensionDays * DAY_MS;
    const newMs = nowMs + durationDays * DAY_MS;
    const currentMs = whitelist.expiresAt ? new Date(whitelist.expiresAt).getTime() : null;
    if (currentMs != null && newMs <= currentMs) return { action: 'skip' };
    return { action: 'extend', expiresAt: new Date(Math.min(newMs, maxMs)) };
  }

  if (earned) return { action: 'grant' };
  return { action: 'progression' };
}
```

- [ ] **Step 4: Run it to verify it passes.** Run: `bun test src/services/seedTracker/__tests__/seederRewardLogic.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/services/seedTracker/seederRewardLogic.js src/services/seedTracker/__tests__/seederRewardLogic.test.js
git commit -m "feat(seedTracker): extract pure reward-decision logic"
```

---

## Task 5: seedingSocket — record serverId, resolve by id, drop the fallback

**Files:**
- Modify: `src/services/seeding/seedingSocket.js`

- [ ] **Step 1: Record serverId on each connection.** In `connectServer` (line 82-84), change the connection object to carry the id:

```javascript
function connectServer(serverCfg) {
  const conn = { socket: null, state: createState(), name: serverCfg.name, serverId: serverCfg.serverId ?? null };
  connections.set(serverCfg.name, conn);
```

- [ ] **Step 2: Add the announcer-server-id holder + import the resolver.** At the top of the file, after line 4 (`import { isRosterStale } ...`), add:

```javascript
import { pickServerStateById, coerceServerId } from './serverResolver.js';
```

After line 13 (`let watchdogInterval = null;`), add:

```javascript
let announcerServerId = null; // set by the scheduler from DB config each tick
export function setAnnouncerServerId(id) { announcerServerId = coerceServerId(id); }
export function getAnnouncerServerId() { return announcerServerId; }
```

- [ ] **Step 3: Fix the NEW_GAME gate** so the rotation-highlight refresh fires for the announcer server by id, not the deleted `config.seeding.seedingServer` name. Replace lines 162-166:

```javascript
    if (discordClient && coerceServerId(conn.serverId) != null && coerceServerId(conn.serverId) === announcerServerId) {
      import('../layerRotationValidator/layerRotationValidatorScheduler.js')
        .then(({ refreshLiveLayerHighlight }) => refreshLiveLayerHighlight(discordClient))
        .catch((err) => log.error({ err }, 'Failed to refresh layer rotation highlight on NEW_GAME'));
    }
```

- [ ] **Step 4: Replace `getServerState` with id-based resolution (no fallback).** Replace the whole function (lines 273-281) with:

```javascript
export function getServerStateById(serverId) {
  const entries = [];
  for (const conn of connections.values()) {
    entries.push({ serverId: conn.serverId, state: conn.state });
  }
  const state = pickServerStateById(entries, serverId);
  if (!state) return null; // unresolved id or no matching connection — caller shows "unavailable"
  return { ...state, players: [...state.players] };
}
```

- [ ] **Step 5: Replace `isConnected` with id-based resolution (no fallback).** Replace the whole function (lines 300-304) with:

```javascript
export function isConnectedById(serverId) {
  const entries = [];
  for (const conn of connections.values()) {
    entries.push({ serverId: conn.serverId, state: conn.state });
  }
  const state = pickServerStateById(entries, serverId);
  return state ? !!state.connected : false;
}
```

- [ ] **Step 6: Find remaining callers of the old names.** Run: `grep -rn "getServerState\b\|isConnected\b" src --include=*.js`
Expected: matches only in `seedingScheduler.js` (handled in Task 7) and any server-status code. For each non-seeding caller, if it used `getServerState()`/`isConnected()` with no arg (first-connection behavior), note it for follow-up — but seeding is the only consumer of these per the current codebase. Record any other caller in the commit message.

- [ ] **Step 7: Commit.**

```bash
git add src/services/seeding/seedingSocket.js
git commit -m "feat(seeding): resolve announcer server by id, remove silent fallback"
```

---

## Task 6: seedingService — config getter, live-status I/O, rapport filter

**Files:**
- Modify: `src/services/seeding/seedingService.js`

- [ ] **Step 1: Extend `getSeedingConfig` to seed the new defaults and parse `role_ids`.** Replace the body of `getSeedingConfig` (lines 9-27) with:

```javascript
export async function getSeedingConfig() {
  const defaults = config.seeding || {};
  let rows = await query('SELECT * FROM seeding_config WHERE id = 1');
  if (!rows[0]) {
    await query(
      `INSERT IGNORE INTO seeding_config
         (id, seed_threshold, reset_threshold, daily_time, timezone,
          required_seed_days, rolling_window_days, whitelist_duration_days, max_extension_days)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        defaults.defaultThreshold || 40,
        defaults.defaultResetThreshold || 20,
        defaults.defaultTime || '16:00',
        defaults.defaultTimezone || 'UTC',
        defaults.defaultRequiredSeedDays || 10,
        defaults.defaultRollingWindowDays || 30,
        defaults.defaultWhitelistDurationDays || 30,
        defaults.defaultMaxExtensionDays || 60,
      ]
    );
    rows = await query('SELECT * FROM seeding_config WHERE id = 1');
  }
  const cfg = rows[0] || null;
  if (cfg) cfg.role_ids = parseRoleIds(cfg.role_ids, cfg.role_id);
  return cfg;
}

// role_ids is a JSON column; fall back to the legacy single role_id when unset.
function parseRoleIds(raw, legacyRoleId) {
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === 'string' && raw.trim()) {
    try { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) list = parsed; } catch { /* ignore */ }
  }
  list = list.map((x) => String(x)).filter(Boolean);
  if (list.length === 0 && legacyRoleId) list = [String(legacyRoleId)];
  return list;
}
```

(Note: the `mariadb` driver may return a `JSON` column as either a parsed array or a string depending on version — `parseRoleIds` handles both.)

- [ ] **Step 2: Add live-status read/write.** At the end of `seedingService.js` (after `getSeedingRapport`, line 245), append:

```javascript
// ── Live status (bot → website) ──

export async function writeLiveStatus({ serverResolvedOk, socketConnected, currentPopulation, currentLayer, activeSessionId }) {
  await query(
    `INSERT INTO seeding_live_status
       (id, server_resolved_ok, socket_connected, current_population, current_layer, active_session_id)
     VALUES (1, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       server_resolved_ok = VALUES(server_resolved_ok),
       socket_connected = VALUES(socket_connected),
       current_population = VALUES(current_population),
       current_layer = VALUES(current_layer),
       active_session_id = VALUES(active_session_id)`,
    [
      serverResolvedOk ? 1 : 0,
      socketConnected ? 1 : 0,
      currentPopulation ?? null,
      currentLayer ?? null,
      activeSessionId ?? null,
    ]
  );
}

export async function getLiveStatus() {
  const rows = await query('SELECT * FROM seeding_live_status WHERE id = 1');
  return rows[0] || null;
}
```

- [ ] **Step 3: Filter `getSeedingRapport` by server.** Change its signature and query. Replace line 198 (`export async function getSeedingRapport(date) {`) with:

```javascript
export async function getSeedingRapport(date, serverId) {
```

In its SQL (lines 200-221), add a server filter on the join row `j`. Replace the `WHERE` clause block:

```javascript
     WHERE j.event_type = 'join'
       AND j.seed_join = 1
       AND j.server_id = ?
       AND DATE(j.time) = ?
     ORDER BY l.seed_duration DESC`,
    [serverId, date],
    'squadjs'
```

(Was `WHERE j.event_type = 'join' AND j.seed_join = 1 AND DATE(j.time) = ?` with params `[date]`.) Callers of `getSeedingRapport` must now pass the tracker server id — the only caller is the website action path (Plan B) and any `/seed rapport` command; update in-repo callers found by `grep -rn "getSeedingRapport" src`.

- [ ] **Step 4: Run the existing+new tests to ensure nothing broke at import time.** Run: `bun test src/config src/services/seeding src/services/seedTracker`
Expected: all pure-logic tests PASS; no import errors from the edited service.

- [ ] **Step 5: Commit.**

```bash
git add src/services/seeding/seedingService.js
git commit -m "feat(seeding): consolidated config defaults, live-status I/O, rapport server filter"
```

---

## Task 7: seedingScheduler — resolve announcer server, role_ids pings, unavailable, live status

**Files:**
- Modify: `src/services/seeding/seedingScheduler.js`

- [ ] **Step 1: Update imports.** Replace line 1:

```javascript
import { getServerStateById, extractGameMode, setAnnouncerServerId } from './seedingSocket.js';
```

Add to the import block from `./seedingService.js` (lines 2-8) the `writeLiveStatus` name:

```javascript
import {
  getSeedingConfig, getActiveSession, startSession, completeSession,
  resetSession, updateSessionPeak, updateSessionCallMessage,
  expireOldSessions, getSeedingStats, trackMessage,
  clearTrackedMessages, setLastDailyCallDate, setPanelMessageId,
  setLastResetDate, writeLiveStatus,
} from './seedingService.js';
```

- [ ] **Step 2: Resolve the server and write live status in `updateSeedingState`.** Replace lines 345-346:

```javascript
    setAnnouncerServerId(cfg.announcer_server_id);
    const state = getServerStateById(cfg.announcer_server_id);
    const session = await getActiveSession();

    // Surface live status for the website regardless of resolution outcome.
    await writeLiveStatus({
      serverResolvedOk: !!state,
      socketConnected: !!state?.connected,
      currentPopulation: state?.connected ? state.playerCount : null,
      currentLayer: state?.connected ? state.currentLayer : null,
      activeSessionId: session?.id ?? null,
    });

    // Unavailable (unresolved id or socket down): never act on stale/absent data.
    if (!state || !state.connected) return;
```

Then DELETE the now-duplicate `const session = await getActiveSession();` that previously sat on line 348 (it was moved above), and the old `if (!state.connected) return;` on line 346.

- [ ] **Step 3: Use the resolved state in `postSeedingCall`, tolerating "unavailable".** Replace line 408:

```javascript
  const state = getServerStateById(cfg.announcer_server_id);
  const available = !!state && !!state.connected;
  const playerCount = available ? state.playerCount : null;
  const currentLayer = available ? state.currentLayer : null;
  const currentLayerObj = available ? state.currentLayerObj : null;
```

Then update the embed call (lines 409-422) to use these locals and pass `playerCount` (which may be null):

```javascript
  const stats = await getSeedingStats();
  const gameMode = extractGameMode(currentLayer);
  const thumbnailUrl = getLayerImageUrl(currentLayerObj, currentLayer);

  const embed = buildSeedingCallEmbed({
    layerName: currentLayer,
    playerCount,
    threshold: cfg.seed_threshold,
    thumbnailUrl,
    avgSeedTime: stats.avgMinutes,
    avgSeedTrend: stats.trend,
    gameMode,
    fastestSeed: stats.fastest,
  });
```

Then update session creation (lines 430-432) to use `playerCount ?? 0` and the locals:

```javascript
  // Start a seeding session (population 0 when unavailable at call time)
  const session = await startSession(state?.currentMap ?? null, currentLayer, playerCount ?? 0);
```

- [ ] **Step 4: Build the role-ping content from `role_ids`.** Replace lines 424-426 (in `postSeedingCall`):

```javascript
  const roleIds = Array.isArray(cfg.role_ids) ? cfg.role_ids : [];
  const roleMention = roleIds.map((id) => `<@&${id}>`).join(' ');
  const content = [roleMention, '**SEEDING HAS BEGUN**'].filter(Boolean).join(' ');
  const allowedMentions = roleIds.length ? { roles: roleIds } : { parse: [] };
```

- [ ] **Step 5: Do the same for `postCompletionMessage`.** Replace lines 448-450:

```javascript
  const roleIds = Array.isArray(cfg.role_ids) ? cfg.role_ids : [];
  const roleMention = roleIds.map((id) => `<@&${id}>`).join(' ');
  const content = [roleMention, '**SEEDING COMPLETE**'].filter(Boolean).join(' ');
  const allowedMentions = roleIds.length ? { roles: roleIds } : { parse: [] };
```

- [ ] **Step 6: Update `updateCallMessage` to use id-resolution.** In `updateCallMessage` (line 458+), it receives `state` from `updateSeedingState`, which is now guaranteed available (we returned early otherwise), so no change is needed to its body. Confirm by reading: the function already takes `state` as a parameter.

- [ ] **Step 7: Smoke-check the module imports.** Run: `bun -e "import('./src/services/seeding/seedingScheduler.js').then(() => console.log('ok'))"`
Expected: prints `ok` (no missing-export errors).

- [ ] **Step 8: Commit.**

```bash
git add src/services/seeding/seedingScheduler.js
git commit -m "feat(seeding): announcer resolves server by id, pings role list, writes live status, handles unavailable"
```

---

## Task 8: seedingEmbeds — render "unavailable" population

**Files:**
- Modify: `src/services/seeding/seedingEmbeds.js`

- [ ] **Step 1: Make the call embed tolerate a null player count.** In `buildSeedingCallEmbed`, replace the `.setDescription(...)` block (lines 63-67):

```javascript
    .setDescription(
      playerCount == null
        ? 'Join the server and help us get live!\n' +
          `Target: **${threshold}** players\n\n` +
          '`Population: unavailable`'
        : 'Join the server and help us get live!\n' +
          `Target: **${threshold}** players\n\n` +
          `\`${playerCount} / ${threshold} players\``
    )
```

- [ ] **Step 2: Manually verify the embed builds both ways.** Run:

```bash
bun -e "import('./src/services/seeding/seedingEmbeds.js').then(({buildSeedingCallEmbed}) => { console.log(buildSeedingCallEmbed({threshold:40, playerCount:null}).data.description.includes('unavailable')); console.log(buildSeedingCallEmbed({threshold:40, playerCount:12}).data.description.includes('12 / 40')); })"
```

Expected: prints `true` then `true`.

- [ ] **Step 3: Commit.**

```bash
git add src/services/seeding/seedingEmbeds.js
git commit -m "feat(seeding): show 'unavailable' population in the call embed"
```

---

## Task 9: seedTrackerService — server_id filter, DB config, decision helper, dynamic duration

**Files:**
- Modify: `src/services/seedTracker/seedTrackerService.js`

- [ ] **Step 1: Add imports.** After line 11 (`import logger ...`), add:

```javascript
import { getSeedingConfig } from '../seeding/seedingService.js';
import { decideSeederAction } from './seederRewardLogic.js';
```

- [ ] **Step 2: Filter `getPlayerSeedStats` by server.** Change its signature (line 15) and SQL. Replace lines 15-29:

```javascript
export async function getPlayerSeedStats(steamId, windowDays = 30, serverId = null) {
  try {
    const rows = await query(
      `SELECT
        COUNT(DISTINCT s.seed_date) AS uniqueDays,
        AVG(s.quality_score) AS avgQuality,
        MAX(s.seed_date) AS lastSeedDate,
        COALESCE(SUM(s.duration_seconds), 0) AS totalDuration
      FROM squadjs_seed_sessions s
      JOIN squadjs_players p ON p.id = s.player_id
      WHERE p.steam_id = ? AND s.status = 'completed'
        AND s.server_id = ?
        AND s.seed_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)`,
      [steamId, serverId, windowDays],
      'squadjs'
    );
```

- [ ] **Step 3: Filter `getSeedStreak` by server.** Replace its signature (line 43) and SQL (lines 45-54):

```javascript
export async function getSeedStreak(steamId, serverId = null) {
  try {
    const rows = await query(
      `SELECT DISTINCT s.seed_date AS seedDate
      FROM squadjs_seed_sessions s
      JOIN squadjs_players p ON p.id = s.player_id
      WHERE p.steam_id = ? AND s.status = 'completed'
        AND s.server_id = ?
      ORDER BY s.seed_date DESC
      LIMIT 100`,
      [steamId, serverId],
      'squadjs'
    );
```

- [ ] **Step 4: Filter `getTopSeeders` by server.** Replace its signature (line 94) and SQL (lines 96-111):

```javascript
export async function getTopSeeders(windowDays = 30, limit = 20, serverId = null) {
  try {
    const rows = await query(
      `SELECT
        p.name, p.steam_id AS steamId,
        COUNT(DISTINCT s.seed_date) AS seedDays,
        COALESCE(SUM(s.duration_seconds), 0) AS totalDuration,
        AVG(s.quality_score) AS avgQuality
      FROM squadjs_seed_sessions s
      JOIN squadjs_players p ON p.id = s.player_id
      WHERE s.status = 'completed'
        AND s.server_id = ?
        AND s.seed_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY s.player_id
      ORDER BY seedDays DESC, totalDuration DESC
      LIMIT ?`,
      [serverId, windowDays, limit],
      'squadjs'
    );
```

- [ ] **Step 5: Rewrite `processCompletedSession` to read DB config + use the decision helper.** Replace the whole function (lines 125-191):

```javascript
export async function processCompletedSession(data, client) {
  try {
    const cfg = await getSeedingConfig();
    if (!cfg?.tracker_enabled) {
      log.debug('seed tracker disabled, skipping');
      return;
    }
    if (cfg.tracker_server_id == null) {
      log.warn('tracker_server_id not configured — seed tracker unavailable, skipping');
      return;
    }
    if (!data?.steamID) {
      log.warn({ player: data?.playerName }, 'Seed session complete event missing steamID, skipping');
      return;
    }

    const requiredDays = cfg.required_seed_days || 10;
    const windowDays = cfg.rolling_window_days || 30;
    const serverId = cfg.tracker_server_id;

    const [stats, whitelist] = await Promise.all([
      getPlayerSeedStats(data.steamID, windowDays, serverId),
      getSeederWhitelist(data.steamID),
    ]);

    const decision = decideSeederAction({
      uniqueDays: stats.uniqueDays,
      requiredDays,
      whitelist,
      durationDays: cfg.whitelist_duration_days || 30,
      maxExtensionDays: cfg.max_extension_days || 60,
      nowMs: Date.now(),
    });

    if (decision.action === 'skip') return;

    if (decision.action === 'extend') {
      await upsertSeederEntry(data.steamID, data.playerName, decision.expiresAt);
      log.info({ steamId: data.steamID, newExpiry: decision.expiresAt }, 'Seeder whitelist renewed');
      return;
    }

    if (decision.action === 'grant') {
      await grantSeederWhitelist(data.steamID, data.playerName, client);
      return;
    }

    // progression
    const channelId = cfg.progression_channel_id;
    if (!channelId) return;
    const streak = await getSeedStreak(data.steamID, serverId);
    const embed = buildProgressionEmbed(
      data.playerName, data.steamID, stats.uniqueDays, requiredDays, streak, stats.avgQuality
    );
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel) await channel.send({ embeds: [embed] });
  } catch (err) {
    log.error({ err, steamId: data?.steamID }, 'Failed to process completed seed session');
  }
}
```

- [ ] **Step 6: Update `grantSeederWhitelist` to read DB config + dynamic duration.** Replace lines 193-237:

```javascript
export async function grantSeederWhitelist(steamId, name, client) {
  try {
    const cfg = await getSeedingConfig();
    if (!cfg) return;

    const durationDays = cfg.whitelist_duration_days || 30;
    const expiresAt = new Date(Date.now() + durationDays * 86400000);

    const result = await upsertSeederEntry(steamId, name, expiresAt);
    if (!result) {
      log.debug({ steamId }, 'Whitelist upsert returned null (player may have non-Seeder WL)');
      return;
    }

    log.info({ steamId, expiresAt }, 'Seeder whitelist granted');

    // Try to DM the player (best-effort)
    try {
      const discordId = await getDiscordIdBySteamId(steamId);
      if (discordId) {
        const user = await client.users.fetch(discordId).catch(() => null);
        if (user) {
          const dmEmbed = buildDmWhitelistNotification(name, expiresAt, durationDays);
          await user.send({ embeds: [dmEmbed] }).catch(() => {
            log.debug({ discordId }, 'Could not DM user about whitelist grant');
          });
        }
      }
    } catch (err) {
      log.debug({ err, steamId }, 'Failed to DM player about whitelist grant');
    }

    const channelId = cfg.progression_channel_id;
    if (!channelId) return;
    const embed = buildWhitelistGrantedEmbed(name, steamId, expiresAt, durationDays);
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel) await channel.send({ embeds: [embed] });
  } catch (err) {
    log.error({ err, steamId }, 'Failed to grant seeder whitelist');
  }
}
```

- [ ] **Step 7: Update `processMilestone` to read DB config.** Replace lines 239-261:

```javascript
export async function processMilestone(data, client) {
  try {
    const cfg = await getSeedingConfig();
    if (!cfg?.tracker_enabled) return;

    const whitelist = await getSeederWhitelist(data.steamID);
    if (whitelist) {
      log.debug({ steamId: data.steamID }, 'Player already whitelisted, skipping milestone');
      return;
    }

    const channelId = cfg.progression_channel_id;
    if (!channelId) return;

    const embed = buildMilestoneEmbed(data.playerName, data.milestone, data.uniqueDays);
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel) await channel.send({ embeds: [embed] });
  } catch (err) {
    log.error({ err, steamId: data?.steamID }, 'Failed to process seed milestone');
  }
}
```

- [ ] **Step 8: Remove the now-unused `config` import** if nothing else uses it. Run: `grep -n "config\." src/services/seedTracker/seedTrackerService.js`
If no matches remain, delete `import config from '../../config.js';` (line 10). If matches remain, leave it.

- [ ] **Step 9: Run the pure tests + import smoke check.** Run: `bun test src/services/seedTracker` then `bun -e "import('./src/services/seedTracker/seedTrackerService.js').then(() => console.log('ok'))"`
Expected: tests PASS; prints `ok`.

- [ ] **Step 10: Commit.**

```bash
git add src/services/seedTracker/seedTrackerService.js
git commit -m "fix(seedTracker): filter seed sessions by server_id, read config from DB, use reward helper"
```

---

## Task 10: seedTrackerEmbeds + seedTrackerScheduler — dynamic duration, DB config

**Files:**
- Modify: `src/services/seedTracker/seedTrackerEmbeds.js`
- Modify: `src/services/seedTracker/seedTrackerScheduler.js`

- [ ] **Step 1: Make grant/DM embeds use the real duration.** In `seedTrackerEmbeds.js`, replace `buildWhitelistGrantedEmbed` (lines 47-56) and `buildDmWhitelistNotification` (lines 72-80):

```javascript
export function buildWhitelistGrantedEmbed(name, steamId, expiresAt, durationDays = 30) {
  return createEmbed('Seed Tracker')
    .setColor(COLOR_SUCCESS)
    .setTitle('Whitelist Earned!')
    .setDescription(`${name} earned a ${durationDays}-day whitelist for seeding!`)
    .addFields(
      { name: 'Steam ID', value: steamId, inline: true },
      { name: 'Expires', value: discordTimestamp(expiresAt), inline: true },
    );
}
```

```javascript
export function buildDmWhitelistNotification(name, expiresAt, durationDays = 30) {
  return createEmbed('Seed Tracker')
    .setColor(COLOR_SUCCESS)
    .setTitle('Whitelist Earned!')
    .setDescription(`Congratulations, ${name}! You earned a ${durationDays}-day whitelist for helping seed Royal Battalion!`)
    .addFields(
      { name: 'Expires', value: discordTimestamp(expiresAt), inline: true },
    );
}
```

- [ ] **Step 2: Make the scheduler read config from the DB.** In `seedTrackerScheduler.js`, replace the imports block (lines 1-7):

```javascript
import logger from '../../logger.js';
import { createScheduler } from '../../utils/scheduler.js';
import { getTopSeeders, getPlayerSeedStats } from './seedTrackerService.js';
import { getSeedingConfig } from '../seeding/seedingService.js';
import { buildLeaderboardEmbed, buildExpiryWarningEmbed } from './seedTrackerEmbeds.js';
import { query } from '../../database/connection.js';
import { reportError } from '../admin/errorAlertService.js';
```

- [ ] **Step 3: Rewrite `tick` to load DB config.** Replace `tick` (lines 14-33):

```javascript
async function tick(client) {
  const cfg = await getSeedingConfig();
  if (!cfg?.tracker_enabled || cfg.tracker_server_id == null) return;

  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${now.getMonth()}`;
  const currentDate = now.toISOString().slice(0, 10);

  if (now.getDate() === 1 && lastLeaderboardMonth !== currentMonth) {
    lastLeaderboardMonth = currentMonth;
    await postLeaderboard(client, cfg);
  }

  if (lastExpiryCheckDate !== currentDate) {
    lastExpiryCheckDate = currentDate;
    await checkExpiringWhitelists(client, cfg);
  }
}
```

- [ ] **Step 4: Update `postLeaderboard` to take cfg.** Replace lines 44-62:

```javascript
async function postLeaderboard(client, cfg) {
  const channelId = cfg.leaderboard_channel_id;
  if (!channelId) return;

  try {
    const windowDays = cfg.rolling_window_days || 30;
    const seeders = await getTopSeeders(windowDays, 20, cfg.tracker_server_id);
    const embed = buildLeaderboardEmbed(seeders, windowDays);

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel) {
      await channel.send({ embeds: [embed] });
      log.info('Monthly seeder leaderboard posted');
    }
  } catch (err) {
    log.error({ err }, 'Failed to post seeder leaderboard');
    reportError(err, { source: 'scheduler:seedTracker:leaderboard' }).catch(() => {});
  }
}
```

- [ ] **Step 5: Update `checkExpiringWhitelists` to take cfg + pass serverId.** Replace lines 64-99:

```javascript
async function checkExpiringWhitelists(client, cfg) {
  const channelId = cfg.progression_channel_id;
  if (!channelId) return;

  try {
    const rows = await query(
      `SELECT id, steamId, name, expiresAt FROM WhitelistEntry
      WHERE role = 'Seeder' AND server = 'main'
      AND expiresAt IS NOT NULL
      AND expiresAt > NOW()
      AND expiresAt <= DATE_ADD(NOW(), INTERVAL 7 DAY)`,
      [],
      'website'
    );

    if (!rows.length) return;

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;

    const requiredDays = cfg.required_seed_days || 10;
    const windowDays = cfg.rolling_window_days || 30;

    for (const entry of rows) {
      const daysRemaining = Math.ceil((new Date(entry.expiresAt).getTime() - Date.now()) / 86400000);
      const stats = await getPlayerSeedStats(entry.steamId, windowDays, cfg.tracker_server_id);
      const seedsNeeded = Math.max(0, requiredDays - stats.uniqueDays);
      const embed = buildExpiryWarningEmbed(entry.name, daysRemaining, seedsNeeded);
      await channel.send({ embeds: [embed] });
    }

    log.info({ count: rows.length }, 'Expiry warnings sent');
  } catch (err) {
    log.warn({ err }, 'Failed to check expiring whitelists');
  }
}
```

- [ ] **Step 6: Update the `/seed_progression` button handler.** Run: `grep -rn "getPlayerSeedStats\|getSeedStreak\|getSeederWhitelist" src/handlers` to find `seedTrackerButtons.js`. It calls these without a serverId. Update those calls to load `const cfg = await getSeedingConfig();` and pass `cfg.tracker_server_id` (and `cfg.required_seed_days`/`cfg.rolling_window_days` where the handler used `config.seedTracker`). Show the exact edit after reading the file; the pattern mirrors Task 9 Step 5.

- [ ] **Step 7: Smoke-check imports.** Run: `bun -e "import('./src/services/seedTracker/seedTrackerScheduler.js').then(() => console.log('ok'))"`
Expected: prints `ok`.

- [ ] **Step 8: Commit.**

```bash
git add src/services/seedTracker/seedTrackerEmbeds.js src/services/seedTracker/seedTrackerScheduler.js src/handlers/seedTrackerButtons.js
git commit -m "feat(seedTracker): dynamic whitelist duration text, DB-driven scheduler config"
```

---

## Task 11: settings + boot log — drop seedingServer/seedTracker, log server ids

**Files:**
- Modify: `settings.production.js`, `settings.staging.js`, `settings.development.js`
- Modify: `src/index.js:46-68`
- Modify: `.env.example`

- [ ] **Step 1: Replace the `seeding` block + delete `seedTracker` in `settings.production.js`.** Replace lines 64-79 (the `seeding:` and `seedTracker:` blocks) with a single defaults-only block:

```javascript
  seeding: {
    // First-insert defaults for the seeding_config DB row. All live config (servers,
    // channels, role list, thresholds, tracker rules) is edited on the website /seeding page.
    defaultThreshold: 40,
    defaultResetThreshold: 20,
    defaultTime: '16:00',
    defaultTimezone: 'UTC',
    defaultRequiredSeedDays: 10,
    defaultRollingWindowDays: 30,
    defaultWhitelistDurationDays: 30,
    defaultMaxExtensionDays: 60,
    schedulerCheckMs: 60000,
  },
```

- [ ] **Step 2: Apply the same change to `settings.staging.js`.** Read it first (`grep -n "seeding\|seedTracker\|seedingServer" settings.staging.js`), then replace its `seeding` and `seedTracker` blocks with the identical defaults-only block from Step 1.

- [ ] **Step 3: Apply to `settings.development.js`.** It has only a `seedTracker` block (lines 52-59) and no `seeding` block. Delete the `seedTracker` block and add the same defaults-only `seeding` block from Step 1.

- [ ] **Step 4: Fix the boot log in `src/index.js`.** Replace lines 54-60 (the `squadjsServers`/`seedingServer`/`seedingChannelId`/`seedingRoleId`/`seedThreshold`/seedTracker lines) with:

```javascript
      squadjsServers: (config.squadjs || []).map(s => ({ name: s.name, url: s.url, serverId: s.serverId })),
      announcerServerId: seedingCfg?.announcer_server_id ?? null,
      trackerServerId: seedingCfg?.tracker_server_id ?? null,
      seedingChannelId: seedingCfg?.channel_id ?? null,
      seedingRoleIds: seedingCfg?.role_ids ?? null,
      seedThreshold: seedingCfg?.seed_threshold ?? null,
      trackerEnabled: !!seedingCfg?.tracker_enabled,
      progressionChannelId: seedingCfg?.progression_channel_id ?? null,
      leaderboardChannelId: seedingCfg?.leaderboard_channel_id ?? null,
```

- [ ] **Step 5: Document the env format.** In `.env.example`, find the `SQUADJS_SERVERS` line (`grep -n SQUADJS_SERVERS .env.example`) and change it to:

```
# Each server: name|url|token|serverId  (serverId = the canonical squadjs_servers.id; comma-separate multiple servers)
SQUADJS_SERVERS=production|ws://127.0.0.1:4000|your-token-here|1
```

- [ ] **Step 6: Confirm no stale references remain.** Run: `grep -rn "seedingServer\|config.seedTracker" src settings.*.js`
Expected: no matches.

- [ ] **Step 7: Commit.**

```bash
git add settings.production.js settings.staging.js settings.development.js src/index.js .env.example
git commit -m "refactor(seeding): move config to DB, drop seedingServer/seedTracker settings, log server ids"
```

---

## Task 12: Full test pass + version bump

**Files:**
- Modify: `package.json:3`

- [ ] **Step 1: Run the whole suite.** Run: `bun test`
Expected: all tests PASS (the three new suites + the two existing layerRotationValidator suites). Fix any failure before continuing.

- [ ] **Step 2: Grep for orphaned old API.** Run: `grep -rn "getServerState(\|isConnected(\|getServerState\b\|\.seedingServer" src`
Expected: only `getServerStateById`/`isConnectedById` usages; no bare `getServerState(`/`isConnected(` and no `.seedingServer`. Fix stragglers.

- [ ] **Step 3: Bump the version.** In `package.json`, change `"version": "2.7.2"` to `"version": "2.8.0"` (minor — new feature behavior).

- [ ] **Step 4: Commit.**

```bash
git add package.json
git commit -m "chore: bump version to 2.8.0 for seeding rework"
```

---

## Rollout (after all tasks merged)

1. **Staging DB** already migrates on bot boot (schema is idempotent). Set the staging `seeding_config` row's `announcer_server_id` / `tracker_server_id` (via website Plan B, or a one-off SQL `UPDATE seeding_config SET announcer_server_id=<id>, tracker_server_id=<id>, tracker_enabled=1 WHERE id=1`) to the staging server's `squadjs_servers.id`.
2. **Staging env:** update `SQUADJS_SERVERS` to the 4-field format with the correct `serverId`.
3. **Deploy bot to staging** (push `main`). Check the `[boot] bot environment` log shows the right `announcerServerId`/`trackerServerId` and `squadjsServers[].serverId`. Verify a seeding call posts against the correct server and that an "unavailable" state shows if you point at a bad id.
4. **Production:** set the prod `seeding_config` server ids, update prod `SQUADJS_SERVERS`, merge `main` → `production`.
5. **Plan B** (website) follows.

---

## Self-Review

**Spec coverage:**
- §2 server identity (id↔socket, no fallback, dropdown source) → Tasks 1,2,3,5,7,11. (Dropdown UI is Plan B; the schema/id it relies on is here.)
- §3 config data model (seeding_config columns, seeding_live_status) → Tasks 1,6.
- §4 announcer (role_ids, resolve by id, unavailable, live status) → Tasks 7,8.
- §5 tracker (server_id filter everywhere, dynamic text, DB config) → Tasks 6 (rapport),9,10.
- §7 testing → Tasks 2,3,4 (pure helpers); SQL filters verified on staging (§Rollout) since the project's test style is pure-function only.
- §8 website → Plan B (explicitly out of scope here).
- §10 rollout (env format, order, semver) → Tasks 11,12 + Rollout section.

**Placeholder scan:** Tasks 5 Step 6, 9 Step 8, 10 Step 6 instruct a `grep` then an edit described by an existing pattern rather than literal code, because the exact lines depend on files not fully quoted in the spec (`seedTrackerButtons.js`, other `getServerState` callers). These are bounded "read then apply the Task-9 pattern" steps, not open-ended TODOs. Everything else has literal code.

**Type/name consistency:** `getServerStateById`/`isConnectedById`/`setAnnouncerServerId`/`getAnnouncerServerId` (Task 5) are used consistently in Task 7. `decideSeederAction` signature (Task 4) matches its call site (Task 9 Step 5). `writeLiveStatus`/`getLiveStatus` (Task 6) match the import + call in Task 7. `parseSquadJsServers` returns `serverId` (Task 2) consumed in Task 5. New `seeding_config` columns (Task 1) match every read in Tasks 6,7,9,10,11.
