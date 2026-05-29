# Layer Rotation Validator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Maintain a single live embed in channel `1509632566548889773` showing the Squad server's current layer rotation, validated via squadutils.org. Source-of-truth is selected at boot via `LAYER_ROTATION_SOURCE=sftp|channel`. SFTP mode polls cfg files every 5 min; Channel mode listens for admin-posted cfg text in the same channel. Errors in SFTP mode page two admin roles in the alerts channel; errors in Channel mode get a ❌ reaction + 30 s auto-delete on the user's message.

**Architecture:** New self-contained service at `src/services/layerRotationValidator/` (four JS files + tests). Reuses `ssh2-sftp-client`, `createScheduler`, the existing `secretary` MariaDB pool, and `discord.js` `Events.MessageCreate`. Persists the last valid rotation to a new single-row table `layer_rotation_current` so the channel survives restarts.

**Tech Stack:** Bun (built-in `bun test`), discord.js v14, `ssh2-sftp-client`, MariaDB (existing `secretary` pool), native `fetch` + `AbortController`, native `crypto.createHash`, Pino logger.

**Spec reference:** `docs/superpowers/specs/2026-05-28-layer-rotation-validator-design.md`

---

## File Structure

**New files:**
- `src/services/layerRotationValidator/layerRotationValidatorService.js` — SFTP fetch, cfg parsers, squadutils API call, hashing, DB read/upsert. No state.
- `src/services/layerRotationValidator/layerRotationValidatorEmbeds.js` — `buildSuccessEmbed`, `buildErrorEmbed`, layer-token prettifier, table formatter. No state.
- `src/services/layerRotationValidator/layerRotationValidatorScheduler.js` — `startScheduler`, `stopScheduler`. Holds module-scoped state: `liveMessageId`, `lastValidHash`, `lastErrorHash`, `lastKnownMode`, `resolvedServerCfgName`, `mode` (sftp/channel), `booted`. Exports `replaceLiveEmbed` for the channel handler to reuse the render path.
- `src/services/layerRotationValidator/layerRotationChannelHandler.js` — `handleMessage(message)`. Stateless; pulls runtime state from the scheduler module via exported accessors.
- `src/services/layerRotationValidator/__tests__/parser.test.js` — parsers + prettifier tests.
- `src/services/layerRotationValidator/__tests__/formatter.test.js` — table formatter tests.

**Modified files:**
- `package.json` — add `test` script.
- `src/database/schema.js` — add `layer_rotation_current` `CREATE TABLE`.
- `settings.production.js` / `settings.staging.js` / `settings.development.js` — `layerRotationValidator` block.
- `src/events/ready.js` — wire `startScheduler` into the `ClientReady` chain.
- `src/events/messageCreate.js` — wire `handleMessage` at the top of `execute`.
- `src/index.js` — import + invoke `stopScheduler` in shutdown.

---

## Task 1: Add bun:test runner script

**Files:**
- Modify: `package.json`

This codebase has no existing tests. Bun has a built-in test runner; no new dependency is needed.

- [ ] **Step 1: Add the test script**

Open `package.json`. Locate the `"scripts"` block:

```json
"scripts": {
  "start": "bun run src/index.js",
  "dev": "bun --watch run src/index.js",
  "deploy-commands": "bun run src/utils/deploy-commands.js"
}
```

Replace with:

```json
"scripts": {
  "start": "bun run src/index.js",
  "dev": "bun --watch run src/index.js",
  "deploy-commands": "bun run src/utils/deploy-commands.js",
  "test": "bun test"
}
```

- [ ] **Step 2: Verify the runner finds no tests yet**

Run: `bun test`
Expected output (paraphrased): `0 pass | 0 fail | 0 expect() calls`. Exit code 0.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore(test): add bun test script"
```

---

## Task 2: parseMapRotationMode

**Files:**
- Create: `src/services/layerRotationValidator/__tests__/parser.test.js`
- Create: `src/services/layerRotationValidator/layerRotationValidatorService.js`

Find the first uncommented `MapRotationMode=<value>` line. Comments start with `//` or `#`, optionally preceded by whitespace. Return the value string, or `null` if no uncommented line found.

- [ ] **Step 1: Write the failing tests**

Create `src/services/layerRotationValidator/__tests__/parser.test.js`:

```js
import { describe, test, expect } from 'bun:test';
import { parseMapRotationMode } from '../layerRotationValidatorService.js';

describe('parseMapRotationMode', () => {
  test('reads a simple uncommented line', () => {
    expect(parseMapRotationMode('MapRotationMode=LayerList')).toBe('LayerList');
  });

  test('reads LayerList_Vote', () => {
    expect(parseMapRotationMode('MapRotationMode=LayerList_Vote')).toBe('LayerList_Vote');
  });

  test('returns the first uncommented value when both forms appear', () => {
    const cfg = [
      'MapRotationMode=LayerList_Vote',
      '//MapRotationMode=LayerList',
    ].join('\n');
    expect(parseMapRotationMode(cfg)).toBe('LayerList_Vote');
  });

  test('skips // comments with surrounding whitespace', () => {
    const cfg = [
      '   //  MapRotationMode=LayerList',
      'MapRotationMode=LayerList_Vote',
    ].join('\n');
    expect(parseMapRotationMode(cfg)).toBe('LayerList_Vote');
  });

  test('skips # comments', () => {
    const cfg = [
      '# MapRotationMode=LayerList',
      'MapRotationMode=Random',
    ].join('\n');
    expect(parseMapRotationMode(cfg)).toBe('Random');
  });

  test('tolerates whitespace around = and at line edges', () => {
    expect(parseMapRotationMode('  MapRotationMode  =  LayerList  ')).toBe('LayerList');
  });

  test('returns null when every MapRotationMode line is commented', () => {
    const cfg = [
      '//MapRotationMode=LayerList',
      '# MapRotationMode=LayerList_Vote',
    ].join('\n');
    expect(parseMapRotationMode(cfg)).toBeNull();
  });

  test('returns null when the directive is absent', () => {
    expect(parseMapRotationMode('ServerName=Royal Battalion\nMaxPlayers=80')).toBeNull();
  });

  test('handles CRLF line endings', () => {
    expect(parseMapRotationMode('MapRotationMode=LayerList\r\n')).toBe('LayerList');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/services/layerRotationValidator/__tests__/parser.test.js`
Expected: every test fails with a module-resolution or "parseMapRotationMode is not a function" error.

- [ ] **Step 3: Write the implementation**

Create `src/services/layerRotationValidator/layerRotationValidatorService.js`:

```js
const MODE_LINE = /^\s*MapRotationMode\s*=\s*(\S+)\s*$/;
const COMMENT_PREFIX = /^\s*(\/\/|#)/;

export function parseMapRotationMode(cfgText) {
  if (!cfgText) return null;
  const lines = cfgText.split(/\r?\n/);
  for (const line of lines) {
    if (COMMENT_PREFIX.test(line)) continue;
    const m = line.match(MODE_LINE);
    if (m) return m[1];
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/services/layerRotationValidator/__tests__/parser.test.js`
Expected: all 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/layerRotationValidator/
git commit -m "feat(layer-rotation): add MapRotationMode parser"
```

---

## Task 3: parseLayerRotation

**Files:**
- Modify: `src/services/layerRotationValidator/__tests__/parser.test.js`
- Modify: `src/services/layerRotationValidator/layerRotationValidatorService.js`

Strip blank lines and comments from cfg text. Returns `{ cleanedText, lines }`. Used by **both** SFTP mode (on `LayerRotation.cfg`) and Channel mode (on the user's posted message content).

- [ ] **Step 1: Add the failing tests**

Append to `src/services/layerRotationValidator/__tests__/parser.test.js`:

```js
import { parseLayerRotation } from '../layerRotationValidatorService.js';

describe('parseLayerRotation', () => {
  test('strips blank lines and trims trailing whitespace', () => {
    const cfg = [
      '',
      'Sumari_Seed_v1 USA MEI   ',
      '',
      'FoolsRoad_RAAS_v1 AFU RGF',
      '',
    ].join('\n');
    const { cleanedText, lines } = parseLayerRotation(cfg);
    expect(lines).toEqual([
      'Sumari_Seed_v1 USA MEI',
      'FoolsRoad_RAAS_v1 AFU RGF',
    ]);
    expect(cleanedText).toBe('Sumari_Seed_v1 USA MEI\nFoolsRoad_RAAS_v1 AFU RGF');
  });

  test('strips // and # comment lines', () => {
    const cfg = [
      '// disabled rotation slot',
      'Sumari_Seed_v1 USA MEI',
      '# also disabled',
      'FoolsRoad_RAAS_v1 AFU RGF',
    ].join('\n');
    const { lines } = parseLayerRotation(cfg);
    expect(lines).toEqual([
      'Sumari_Seed_v1 USA MEI',
      'FoolsRoad_RAAS_v1 AFU RGF',
    ]);
  });

  test('handles CRLF line endings', () => {
    const cfg = 'Sumari_Seed_v1 USA MEI\r\nFoolsRoad_RAAS_v1 AFU RGF\r\n';
    const { lines } = parseLayerRotation(cfg);
    expect(lines).toEqual([
      'Sumari_Seed_v1 USA MEI',
      'FoolsRoad_RAAS_v1 AFU RGF',
    ]);
  });

  test('keeps single-token lines (mestia-style maps without explicit factions)', () => {
    const { lines } = parseLayerRotation('Mestia_TC_v1');
    expect(lines).toEqual(['Mestia_TC_v1']);
  });

  test('returns empty arrays for empty/blank input', () => {
    expect(parseLayerRotation('').lines).toEqual([]);
    expect(parseLayerRotation('\n\n  \n').lines).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/services/layerRotationValidator/__tests__/parser.test.js`
Expected: 5 new tests fail with "parseLayerRotation is not a function". Task 2 tests still pass.

- [ ] **Step 3: Implement parseLayerRotation**

Append to `src/services/layerRotationValidator/layerRotationValidatorService.js`:

```js
export function parseLayerRotation(cfgText) {
  if (!cfgText) return { cleanedText: '', lines: [] };
  const lines = cfgText
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.length > 0)
    .filter((l) => !COMMENT_PREFIX.test(l));
  return { cleanedText: lines.join('\n'), lines };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/services/layerRotationValidator/__tests__/parser.test.js`
Expected: all 14 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/layerRotationValidator/
git commit -m "feat(layer-rotation): add LayerRotation.cfg parser"
```

---

## Task 4: prettifyLayerToken

**Files:**
- Create: `src/services/layerRotationValidator/layerRotationValidatorEmbeds.js`
- Modify: `src/services/layerRotationValidator/__tests__/parser.test.js`

Tokenize a cfg line like `FoolsRoad_RAAS_v1 AFU RGF` into `{ map, variant, team1, team2 }`. See spec section "Squad layer parser & embed renderer".

- [ ] **Step 1: Add the failing tests**

Append to `src/services/layerRotationValidator/__tests__/parser.test.js`:

```js
import { prettifyLayerToken } from '../layerRotationValidatorEmbeds.js';

describe('prettifyLayerToken', () => {
  test('parses a standard CamelCase map line', () => {
    expect(prettifyLayerToken('FoolsRoad_RAAS_v1 AFU RGF')).toEqual({
      map: 'Fools Road', variant: 'RAAS v1', team1: 'AFU', team2: 'RGF',
    });
  });

  test('parses a single-word map name', () => {
    expect(prettifyLayerToken('Sumari_Seed_v1 USA MEI')).toEqual({
      map: 'Sumari', variant: 'Seed v1', team1: 'USA', team2: 'MEI',
    });
  });

  test('parses BlackCoast and GooseBay', () => {
    expect(prettifyLayerToken('BlackCoast_RAAS_v1 PLA+Motorized CAF+Motorized')).toEqual({
      map: 'Black Coast', variant: 'RAAS v1', team1: 'PLA + Motorized', team2: 'CAF + Motorized',
    });
    expect(prettifyLayerToken('GooseBay_RAAS_v2 CAF CRF')).toEqual({
      map: 'Goose Bay', variant: 'RAAS v2', team1: 'CAF', team2: 'CRF',
    });
  });

  test('joins faction unit suffixes with spaces around +', () => {
    expect(prettifyLayerToken('Lashkar_RAAS_v1 CAF+AirAssault WPMC+AirAssault')).toEqual({
      map: 'Lashkar', variant: 'RAAS v1', team1: 'CAF + AirAssault', team2: 'WPMC + AirAssault',
    });
  });

  test('renders missing teams as -', () => {
    expect(prettifyLayerToken('Mestia_TC_v1')).toEqual({
      map: 'Mestia', variant: 'TC v1', team1: '-', team2: '-',
    });
  });

  test('handles missing version', () => {
    expect(prettifyLayerToken('Sumari_RAAS USA MEI')).toEqual({
      map: 'Sumari', variant: 'RAAS', team1: 'USA', team2: 'MEI',
    });
  });

  test('handles multi-segment map names', () => {
    expect(prettifyLayerToken('Black_Coast_RAAS_v1 PLA CAF')).toEqual({
      map: 'Black Coast', variant: 'RAAS v1', team1: 'PLA', team2: 'CAF',
    });
  });

  test('falls back gracefully on a single-token layer', () => {
    expect(prettifyLayerToken('SomeRawToken USA MEI')).toEqual({
      map: 'SomeRawToken', variant: '', team1: 'USA', team2: 'MEI',
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/services/layerRotationValidator/__tests__/parser.test.js`
Expected: 8 tests fail because `layerRotationValidatorEmbeds.js` doesn't exist yet.

- [ ] **Step 3: Implement prettifyLayerToken**

Create `src/services/layerRotationValidator/layerRotationValidatorEmbeds.js`:

```js
const VERSION_RE = /^v\d+$/i;

function splitCamelCase(s) {
  return s.replace(/([a-z])([A-Z])/g, '$1 $2');
}

function joinMapSegments(segments) {
  return segments.map(splitCamelCase).join(' ');
}

function formatTeam(raw) {
  if (!raw) return '-';
  return raw.split('+').map((s) => s.trim()).filter(Boolean).join(' + ') || '-';
}

export function prettifyLayerToken(line) {
  const parts = String(line).trim().split(/\s+/);
  const layerToken = parts[0] || '';
  const team1 = formatTeam(parts[1]);
  const team2 = formatTeam(parts[2]);

  const segments = layerToken.split('_');
  if (segments.length < 2) {
    return { map: layerToken, variant: '', team1, team2 };
  }

  const last = segments[segments.length - 1];
  let modeIdx, version;
  if (VERSION_RE.test(last)) {
    modeIdx = segments.length - 2;
    version = last;
  } else {
    modeIdx = segments.length - 1;
    version = '';
  }

  const mode = segments[modeIdx] || '';
  const map = joinMapSegments(segments.slice(0, modeIdx));
  const variant = version ? `${mode} ${version}` : mode;

  return { map, variant, team1, team2 };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/services/layerRotationValidator/__tests__/parser.test.js`
Expected: all 22 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/layerRotationValidator/
git commit -m "feat(layer-rotation): add layer-token prettifier"
```

---

## Task 5: formatRotationTable

**Files:**
- Create: `src/services/layerRotationValidator/__tests__/formatter.test.js`
- Modify: `src/services/layerRotationValidator/layerRotationValidatorEmbeds.js`

Aligned 5-column table inside a code block, computed widths.

- [ ] **Step 1: Write the failing tests**

Create `src/services/layerRotationValidator/__tests__/formatter.test.js`:

```js
import { describe, test, expect } from 'bun:test';
import { formatRotationTable } from '../layerRotationValidatorEmbeds.js';

describe('formatRotationTable', () => {
  test('produces a header and one row per layer with aligned columns', () => {
    const lines = [
      'Sumari_Seed_v1 USA MEI',
      'FoolsRoad_RAAS_v1 AFU RGF',
    ];
    const out = formatRotationTable(lines);
    const rows = out.split('\n');
    expect(rows[0]).toMatch(/^ #\s+Map\s+Variant\s+Team 1\s+Team 2\s*$/);
    expect(rows[1]).toMatch(/^ 1\s+Sumari\s+Seed v1\s+USA\s+MEI\s*$/);
    expect(rows[2]).toMatch(/^ 2\s+Fools Road\s+RAAS v1\s+AFU\s+RGF\s*$/);
    const widths = rows.filter(Boolean).map((r) => r.length);
    expect(new Set(widths).size).toBe(1);
  });

  test('renders missing teams as -', () => {
    const lines = ['Mestia_TC_v1'];
    const out = formatRotationTable(lines);
    expect(out).toMatch(/Mestia\s+TC v1\s+-\s+-/);
  });

  test('right-pads numeric index to fit the highest row number', () => {
    const lines = Array.from({ length: 12 }, () => 'Sumari_RAAS_v1 USA MEI');
    const out = formatRotationTable(lines);
    const rows = out.split('\n').filter(Boolean);
    expect(rows.length).toBe(13);
    expect(rows[12]).toMatch(/^12\s+Sumari/);
    expect(rows[1]).toMatch(/^ 1\s+Sumari/);
  });

  test('returns "(empty rotation)" for an empty input', () => {
    expect(formatRotationTable([])).toBe('(empty rotation)');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/services/layerRotationValidator/__tests__/formatter.test.js`
Expected: all 4 tests fail with "formatRotationTable is not a function".

- [ ] **Step 3: Implement formatRotationTable**

Append to `src/services/layerRotationValidator/layerRotationValidatorEmbeds.js`:

```js
function padRight(s, width) { return s + ' '.repeat(Math.max(0, width - s.length)); }
function padLeft(s, width)  { return ' '.repeat(Math.max(0, width - s.length)) + s; }

export function formatRotationTable(lines) {
  if (!lines || lines.length === 0) return '(empty rotation)';

  const rows = lines.map((line, idx) => {
    const parsed = prettifyLayerToken(line);
    return { idx: String(idx + 1), ...parsed };
  });

  const headers = { idx: '#', map: 'Map', variant: 'Variant', team1: 'Team 1', team2: 'Team 2' };
  const all = [headers, ...rows];

  const widths = {
    idx: Math.max(...all.map((r) => r.idx.length)),
    map: Math.max(...all.map((r) => r.map.length)),
    variant: Math.max(...all.map((r) => r.variant.length)),
    team1: Math.max(...all.map((r) => r.team1.length)),
    team2: Math.max(...all.map((r) => r.team2.length)),
  };

  const fmt = (r) =>
    `${padLeft(r.idx, widths.idx)}  ` +
    `${padRight(r.map, widths.map)}  ` +
    `${padRight(r.variant, widths.variant)}  ` +
    `${padRight(r.team1, widths.team1)}  ` +
    `${padRight(r.team2, widths.team2)}`;

  return all.map(fmt).join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test`
Expected: all 26 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/layerRotationValidator/
git commit -m "feat(layer-rotation): add rotation table formatter"
```

---

## Task 6: Embed builders (success + error)

**Files:**
- Modify: `src/services/layerRotationValidator/layerRotationValidatorEmbeds.js`

`buildSuccessEmbed({ mode, lines })` → green embed with table. `buildErrorEmbed({ errors })` → red embed with formatted error list.

- [ ] **Step 1: Append the embed builders**

Append to `src/services/layerRotationValidator/layerRotationValidatorEmbeds.js`:

```js
import { EmbedBuilder } from 'discord.js';

const COLOR_OK = 0x57F287;
const COLOR_ERR = 0xED4245;
const FOOTER = 'Validated via squadutils.org';

function modeLabel(mode) {
  if (mode === 'LayerList_Vote') return 'LayerList_Vote (players vote)';
  if (!mode) return 'Unknown';
  return mode;
}

export function buildSuccessEmbed({ mode, lines }) {
  const table = formatRotationTable(lines);
  const unix = Math.floor(Date.now() / 1000);
  const description =
    `Mode: ${modeLabel(mode)}  |  ${lines.length} layers  |  Updated <t:${unix}:R>\n` +
    '```\n' + table + '\n```';
  return new EmbedBuilder()
    .setColor(COLOR_OK)
    .setTitle('Royal Battalion - Layer Rotation')
    .setDescription(description)
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

export function buildErrorEmbed({ errors }) {
  const safeErrors = Array.isArray(errors) ? errors : [];
  const lines = safeErrors.map((e) => `Line ${e.line}: ${e.content} - ${e.error}`);
  const body = lines.length > 0 ? lines.join('\n') : 'No error detail returned.';
  const description = '```js\n' + (body.length > 3900 ? body.slice(0, 3900) + '\n... (truncated)' : body) + '\n```';
  return new EmbedBuilder()
    .setColor(COLOR_ERR)
    .setTitle('Layer rotation has errors')
    .setDescription(description)
    .setFooter({ text: FOOTER })
    .setTimestamp();
}
```

- [ ] **Step 2: Verify the file still parses**

Run: `bun test`
Expected: all 26 tests still pass.

- [ ] **Step 3: Commit**

```bash
git add src/services/layerRotationValidator/layerRotationValidatorEmbeds.js
git commit -m "feat(layer-rotation): add success and error embed builders"
```

---

## Task 7: SFTP fetch + squadutils API call + hashing

**Files:**
- Modify: `src/services/layerRotationValidator/layerRotationValidatorService.js`

`fetchCfgFiles` is parameterised to fetch either just Server.cfg (Channel mode) or both files (SFTP mode), controlled by a `serverCfgOnly` flag. `validateRotation` calls the API with a 15 s timeout. `hashRotation` and `hashErrors` produce stable SHA-1 hex strings.

- [ ] **Step 1: Append the boundary helpers**

Append to `src/services/layerRotationValidator/layerRotationValidatorService.js`:

```js
import SftpClient from 'ssh2-sftp-client';
import { createHash } from 'crypto';

export async function fetchCfgFiles(sftpConfig, opts) {
  const {
    serverCfgName,
    layerRotationName,
    cachedServerCfgName,
    serverCfgOnly = false,
  } = opts;

  const sftp = new SftpClient('layer-rotation-validator');
  await sftp.connect({
    host: sftpConfig.host,
    port: sftpConfig.port,
    username: sftpConfig.user,
    password: sftpConfig.pass,
    readyTimeout: 30_000,
    retries: 2,
    retry_factor: 1,
    retry_minTimeout: 1_000,
  });
  try {
    const namesToTry = cachedServerCfgName
      ? [cachedServerCfgName]
      : [serverCfgName, serverCfgName.toLowerCase()].filter((v, i, a) => a.indexOf(v) === i);

    let serverCfgBuf = null;
    let resolvedServerCfgName = null;
    for (const name of namesToTry) {
      try {
        serverCfgBuf = await sftp.get(`${sftpConfig.path}/${name}`);
        resolvedServerCfgName = name;
        break;
      } catch (err) {
        if (!/no such file/i.test(err?.message || '')) throw err;
      }
    }
    if (!serverCfgBuf) {
      throw new Error(`Server cfg not found (tried: ${namesToTry.join(', ')})`);
    }

    if (serverCfgOnly) {
      return {
        serverCfgText: serverCfgBuf.toString('utf-8'),
        layerRotationText: null,
        resolvedServerCfgName,
      };
    }

    const layerRotationBuf = await sftp.get(`${sftpConfig.path}/${layerRotationName}`);
    return {
      serverCfgText: serverCfgBuf.toString('utf-8'),
      layerRotationText: layerRotationBuf.toString('utf-8'),
      resolvedServerCfgName,
    };
  } finally {
    await sftp.end().catch(() => {});
  }
}

export async function validateRotation(squadUtilsUrl, cleanedText) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const resp = await fetch(squadUtilsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rotation: cleanedText }),
      signal: ctrl.signal,
    });
    if (resp.status !== 200 && resp.status !== 422) {
      return { ok: false, errors: null, fetchError: `HTTP ${resp.status}` };
    }
    const data = await resp.json().catch(() => null);
    if (!data) return { ok: false, errors: null, fetchError: 'invalid JSON' };
    const errors = Array.isArray(data.errors) ? data.errors : [];
    return { ok: errors.length === 0, errors };
  } catch (err) {
    const msg = err?.name === 'AbortError' ? 'timeout' : err?.message || 'unknown';
    return { ok: false, errors: null, fetchError: msg };
  } finally {
    clearTimeout(timer);
  }
}

export function hashRotation(mode, cleanedText) {
  return createHash('sha1').update(`${mode}\n${cleanedText}`).digest('hex');
}

export function hashErrors(errors) {
  const safe = Array.isArray(errors) ? errors : [];
  const norm = safe.map((e) => `${e.line}|${e.content}|${e.error}`).sort().join('\n');
  return createHash('sha1').update(norm).digest('hex');
}
```

- [ ] **Step 2: Verify the project still loads**

Run: `bun test`
Expected: all 26 tests still pass.

- [ ] **Step 3: Commit**

```bash
git add src/services/layerRotationValidator/layerRotationValidatorService.js
git commit -m "feat(layer-rotation): add SFTP fetch, squadutils client, hashing"
```

---

## Task 8: DB schema + persistence helpers

**Files:**
- Modify: `src/database/schema.js`
- Modify: `src/services/layerRotationValidator/layerRotationValidatorService.js`

Single-row table `layer_rotation_current` (id=1). Two helpers in the service module: `readPersistedRotation()` and `upsertPersistedRotation({ cleanedText, mode, source })`.

- [ ] **Step 1: Add CREATE TABLE to initSchema**

Open `src/database/schema.js`. Find the end of `initSchema()` (search for the last `await query(\`CREATE TABLE` or similar). Append a new block:

```js
  await query(`
    CREATE TABLE IF NOT EXISTS layer_rotation_current (
      id TINYINT UNSIGNED NOT NULL DEFAULT 1 PRIMARY KEY,
      cleaned_text TEXT NOT NULL,
      mode VARCHAR(32) NOT NULL,
      source ENUM('sftp','channel') NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
```

Place this BEFORE the closing `log.info(...)` / `}` of `initSchema`. Match the indentation of the surrounding `await query` calls.

- [ ] **Step 2: Add the read + upsert helpers**

Append to `src/services/layerRotationValidator/layerRotationValidatorService.js`:

```js
import { query } from '../../database/connection.js';

export async function readPersistedRotation() {
  const rows = await query(
    'SELECT cleaned_text, mode, source FROM layer_rotation_current WHERE id = 1 LIMIT 1'
  );
  if (!rows || rows.length === 0) return null;
  const row = rows[0];
  if (typeof row.cleaned_text !== 'string' || typeof row.mode !== 'string') return null;
  return {
    cleanedText: row.cleaned_text,
    mode: row.mode,
    source: row.source,
  };
}

export async function upsertPersistedRotation({ cleanedText, mode, source }) {
  await query(
    `INSERT INTO layer_rotation_current (id, cleaned_text, mode, source)
     VALUES (1, ?, ?, ?)
     ON DUPLICATE KEY UPDATE cleaned_text = VALUES(cleaned_text), mode = VALUES(mode), source = VALUES(source)`,
    [cleanedText, mode, source]
  );
}
```

- [ ] **Step 3: Verify it still parses**

Run: `bun test`
Expected: all 26 tests still pass. The DB module is imported but not invoked during tests.

- [ ] **Step 4: Commit**

```bash
git add src/database/schema.js src/services/layerRotationValidator/layerRotationValidatorService.js
git commit -m "feat(layer-rotation): persist last rotation in MariaDB"
```

---

## Task 9: Scheduler with channel-clear, message lifecycle, and mode branching

**Files:**
- Create: `src/services/layerRotationValidator/layerRotationValidatorScheduler.js`

Holds module-scoped state. Reads `LAYER_ROTATION_SOURCE` at `startScheduler` time. SFTP mode tick polls both files + validates + renders. Channel mode tick only polls Server.cfg for mode-badge updates. Exports `replaceLiveEmbed`, `getMode`, `getChannelId`, `getRoleIds`, `getSquadUtilsUrl`, `getLastValidHash`, `setLastValidHash`, `getLastKnownMode` for the channel handler module to use.

- [ ] **Step 1: Write the scheduler module**

Create `src/services/layerRotationValidator/layerRotationValidatorScheduler.js`:

```js
import logger from '../../logger.js';
import config from '../../config.js';
import { createScheduler } from '../../utils/scheduler.js';
import {
  parseMapRotationMode,
  parseLayerRotation,
  fetchCfgFiles,
  validateRotation,
  hashRotation,
  hashErrors,
  readPersistedRotation,
  upsertPersistedRotation,
} from './layerRotationValidatorService.js';
import { buildSuccessEmbed, buildErrorEmbed } from './layerRotationValidatorEmbeds.js';

const log = logger.child({ module: 'layerRotationValidator' });

const VALID_MODES = new Set(['LayerList', 'LayerList_Vote']);

let mode = 'sftp';
let liveMessageId = null;
let lastValidHash = null;
let lastErrorHash = null;
let lastKnownMode = null;
let resolvedServerCfgName = null;
let booted = false;
let warnedAboutUnusedMode = false;
let warnedAboutSftpMissing = false;

function getSettings() {
  return config.layerRotationValidator || null;
}

function getSftpConfig() {
  const host = process.env.SFTP_HOST;
  const user = process.env.SFTP_USER;
  const pass = process.env.SFTP_PASS;
  const path = process.env.SFTP_PATH;
  if (!host || !user || !pass || !path) return null;
  return {
    host,
    port: parseInt(process.env.SFTP_PORT || '22', 10),
    user, pass, path,
  };
}

function getSquadUtilsUrl() {
  return getSettings()?.squadUtilsUrl || process.env.SQUAD_UTILS_URL || 'https://squadutils.org/api/v3/parse';
}

async function clearChannel(client, channelId) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    log.warn({ channelId }, 'Prod channel not found - skipping clear');
    return null;
  }
  try {
    const messages = await channel.messages.fetch({ limit: 100 });
    if (messages.size > 0) {
      await channel.bulkDelete(messages, true).catch(() => {});
      const remaining = await channel.messages.fetch({ limit: 100 }).catch(() => null);
      if (remaining) {
        let oldDeleted = 0;
        for (const msg of remaining.values()) {
          await msg.delete().catch(() => {});
          oldDeleted += 1;
          await new Promise((r) => setTimeout(r, 250));
        }
        if (oldDeleted > 0) log.info({ oldDeleted }, 'Deleted messages older than bulkDelete limit');
      }
    }
    log.info({ channelId }, 'Prod channel cleared on boot');
    return channel;
  } catch (err) {
    log.warn({ err }, 'Channel clear failed (continuing)');
    return channel;
  }
}

export async function replaceLiveEmbed(client, { mode: embedMode, lines, source }) {
  const settings = getSettings();
  if (!settings?.channelId) return;
  const channel = await client.channels.fetch(settings.channelId).catch(() => null);
  if (!channel) {
    log.error({ channelId: settings.channelId }, 'Cannot fetch prod channel for embed post');
    return;
  }
  const embed = buildSuccessEmbed({ mode: embedMode, lines });
  const sent = await channel.send({ embeds: [embed] }).catch((err) => {
    log.error({ err }, 'Failed to send success embed');
    return null;
  });
  if (!sent) return;
  const previousId = liveMessageId;
  liveMessageId = sent.id;
  if (previousId) {
    const old = await channel.messages.fetch(previousId).catch(() => null);
    if (old) await old.delete().catch(() => {});
  }
  try {
    await upsertPersistedRotation({
      cleanedText: lines.join('\n'),
      mode: embedMode || 'Unknown',
      source,
    });
  } catch (err) {
    log.warn({ err }, 'Failed to upsert persisted rotation');
  }
  log.info({ mode: embedMode, layers: lines.length, source }, 'Posted updated rotation embed');
}

async function postError(client, settings, errors) {
  const alertsChannelId = config.alerts?.channelId;
  if (!alertsChannelId) {
    log.warn('config.alerts.channelId missing - cannot post rotation error');
    return;
  }
  const channel = await client.channels.fetch(alertsChannelId).catch(() => null);
  if (!channel) {
    log.error({ alertsChannelId }, 'Alerts channel not found');
    return;
  }
  const roleIds = Array.isArray(settings.errorRoleIds) ? settings.errorRoleIds : [];
  const mentions = roleIds.map((id) => `<@&${id}>`).join(' ');
  const content = `${mentions} Layer rotation failed validation`.trim();
  const embed = buildErrorEmbed({ errors });
  await channel.send({
    content,
    embeds: [embed],
    allowedMentions: { roles: roleIds },
  }).catch((err) => log.error({ err }, 'Failed to send rotation-error alert'));
}

async function restoreFromPersistence(client, settings) {
  let row = null;
  try {
    row = await readPersistedRotation();
  } catch (err) {
    log.warn({ err }, 'Failed to read persisted rotation');
    return;
  }
  if (!row) return;
  const { lines } = parseLayerRotation(row.cleaned_text || row.cleanedText);
  if (lines.length === 0) return;
  lastKnownMode = row.mode || lastKnownMode;
  await replaceLiveEmbed(client, { mode: row.mode || 'Unknown', lines, source: row.source });
  lastValidHash = hashRotation(row.mode || 'Unknown', lines.join('\n'));
}

async function tickSftpMode(client, settings) {
  const sftpConfig = getSftpConfig();
  if (!sftpConfig) {
    if (!warnedAboutSftpMissing) {
      log.warn('SFTP env vars missing - SFTP mode inactive');
      warnedAboutSftpMissing = true;
    }
    return;
  }

  let cfgs;
  try {
    cfgs = await fetchCfgFiles(sftpConfig, {
      serverCfgName: settings.serverCfgName || 'Server.cfg',
      layerRotationName: settings.layerRotationName || 'LayerRotation.cfg',
      cachedServerCfgName: resolvedServerCfgName,
    });
    resolvedServerCfgName = cfgs.resolvedServerCfgName;
  } catch (err) {
    log.warn({ err: err?.message }, 'SFTP fetch failed - skipping tick');
    return;
  }

  const parsedMode = parseMapRotationMode(cfgs.serverCfgText);
  if (!VALID_MODES.has(parsedMode)) {
    if (!warnedAboutUnusedMode) {
      log.warn({ mode: parsedMode }, 'MapRotationMode is not LayerList or LayerList_Vote - skipping');
      warnedAboutUnusedMode = true;
    }
    return;
  }
  warnedAboutUnusedMode = false;
  lastKnownMode = parsedMode;

  const { cleanedText, lines } = parseLayerRotation(cfgs.layerRotationText);
  const hash = hashRotation(parsedMode, cleanedText);
  if (hash === lastValidHash) return;

  const result = await validateRotation(getSquadUtilsUrl(), cleanedText);
  if (result.fetchError) {
    log.warn({ fetchError: result.fetchError }, 'Squadutils API call failed - skipping tick');
    return;
  }

  if (!result.ok) {
    const errHash = hashErrors(result.errors);
    if (errHash === lastErrorHash) return;
    lastErrorHash = errHash;
    await postError(client, settings, result.errors);
    return;
  }

  lastErrorHash = null;
  lastValidHash = hash;
  await replaceLiveEmbed(client, { mode: parsedMode, lines, source: 'sftp' });
}

async function tickChannelMode(client, settings) {
  const sftpConfig = getSftpConfig();
  if (!sftpConfig) {
    if (!warnedAboutSftpMissing) {
      log.warn('SFTP env vars missing - Channel mode running without mode-badge refresh');
      warnedAboutSftpMissing = true;
    }
    return;
  }

  let cfgs;
  try {
    cfgs = await fetchCfgFiles(sftpConfig, {
      serverCfgName: settings.serverCfgName || 'Server.cfg',
      layerRotationName: settings.layerRotationName || 'LayerRotation.cfg',
      cachedServerCfgName: resolvedServerCfgName,
      serverCfgOnly: true,
    });
    resolvedServerCfgName = cfgs.resolvedServerCfgName;
  } catch (err) {
    log.warn({ err: err?.message }, 'SFTP fetch (Server.cfg only) failed - keeping cached mode');
    return;
  }

  const parsedMode = parseMapRotationMode(cfgs.serverCfgText);
  if (!VALID_MODES.has(parsedMode)) {
    log.warn({ mode: parsedMode }, 'MapRotationMode is not LayerList/Vote - badge will say Unknown');
    return;
  }

  if (parsedMode === lastKnownMode) return;
  const previousMode = lastKnownMode;
  lastKnownMode = parsedMode;

  if (previousMode === null) {
    // First successful Server.cfg read; no embed to refresh.
    return;
  }

  // Mode changed. Re-render the current rotation (if any) with the new badge.
  let row = null;
  try {
    row = await readPersistedRotation();
  } catch (err) {
    log.warn({ err }, 'Persisted rotation read failed during mode-refresh');
    return;
  }
  if (!row) return;
  const { lines } = parseLayerRotation(row.cleaned_text || row.cleanedText);
  if (lines.length === 0) return;
  await replaceLiveEmbed(client, { mode: parsedMode, lines, source: row.source || 'channel' });
  lastValidHash = hashRotation(parsedMode, lines.join('\n'));
}

async function tick(client) {
  const settings = getSettings();
  if (!settings?.enabled || !settings.channelId) return;

  if (!booted) {
    await clearChannel(client, settings.channelId);
    await restoreFromPersistence(client, settings);
    booted = true;
  }

  if (mode === 'channel') {
    await tickChannelMode(client, settings);
  } else {
    await tickSftpMode(client, settings);
  }
}

const scheduler = createScheduler({
  name: 'layerRotationValidator',
  intervalMs: 5 * 60 * 1000,
  tick,
});

export async function startScheduler(client) {
  const settings = getSettings();
  if (!settings?.enabled) {
    log.info('layerRotationValidator disabled in settings - not starting');
    return;
  }
  if (!settings.channelId) {
    log.warn('layerRotationValidator.channelId missing - not starting');
    return;
  }
  const envSource = (process.env.LAYER_ROTATION_SOURCE || '').toLowerCase();
  if (envSource === 'channel') {
    mode = 'channel';
  } else if (envSource === 'sftp' || envSource === '') {
    mode = 'sftp';
  } else {
    log.warn({ LAYER_ROTATION_SOURCE: envSource }, 'Unknown LAYER_ROTATION_SOURCE value, defaulting to sftp');
    mode = 'sftp';
  }
  log.info({ mode }, `layerRotationValidator started (5-minute polling, source=${mode})`);
  scheduler.start(client);
}

export function stopScheduler() {
  scheduler.stop();
  liveMessageId = null;
  lastValidHash = null;
  lastErrorHash = null;
  lastKnownMode = null;
  resolvedServerCfgName = null;
  booted = false;
  warnedAboutUnusedMode = false;
  warnedAboutSftpMissing = false;
}

// Accessors used by layerRotationChannelHandler.js
export function getMode() { return mode; }
export function getChannelId() { return getSettings()?.channelId || null; }
export function getRoleIds() { return getSettings()?.errorRoleIds || []; }
export function getLastValidHash() { return lastValidHash; }
export function setLastValidHash(h) { lastValidHash = h; }
export function getLastKnownMode() { return lastKnownMode; }
```

- [ ] **Step 2: Verify the module imports cleanly**

Run: `bun test`
Expected: all 26 unit tests still pass; no import errors.

- [ ] **Step 3: Commit**

```bash
git add src/services/layerRotationValidator/layerRotationValidatorScheduler.js
git commit -m "feat(layer-rotation): add mode-aware scheduler with channel-clear and persistence"
```

---

## Task 10: Channel-mode message handler

**Files:**
- Create: `src/services/layerRotationValidator/layerRotationChannelHandler.js`

Exports `handleMessage(message)`. Returns `true` if the message belongs to our channel (and we either deleted it, validated it, or deliberately let it pass because the author was the bot). Returns `false` otherwise so `messageCreate.js` can continue normal routing.

Behaviour matrix:
| Condition | Action | Returns |
|---|---|---|
| No guild / wrong channel / no settings | none | `false` |
| Author is bot (e.g. our own embed) | none | `true` (handled, stop further routing) |
| Mode = sftp | delete silently | `true` |
| Mode = channel, author lacks both alert roles | delete silently, log info | `true` |
| Mode = channel, author has role, posted content empty | delete silently | `true` |
| Mode = channel, author has role, API network failure | react ❌, schedule delete in 30s | `true` |
| Mode = channel, author has role, API returns errors | react ❌, schedule delete in 30s | `true` |
| Mode = channel, author has role, valid, hash matches current | delete user msg, no embed change | `true` |
| Mode = channel, author has role, valid, new content | delete user msg, replaceLiveEmbed, update hash | `true` |

- [ ] **Step 1: Write the handler module**

Create `src/services/layerRotationValidator/layerRotationChannelHandler.js`:

```js
import logger from '../../logger.js';
import {
  getMode,
  getChannelId,
  getRoleIds,
  getLastValidHash,
  setLastValidHash,
  getLastKnownMode,
  replaceLiveEmbed,
} from './layerRotationValidatorScheduler.js';
import { parseLayerRotation, validateRotation, hashRotation } from './layerRotationValidatorService.js';
import config from '../../config.js';

const log = logger.child({ module: 'layerRotationChannel' });

const REJECT_DELETE_MS = 30_000;

function getSquadUtilsUrl() {
  return config.layerRotationValidator?.squadUtilsUrl
    || process.env.SQUAD_UTILS_URL
    || 'https://squadutils.org/api/v3/parse';
}

async function rejectInvalid(message) {
  await message.react('❌').catch(() => {});
  setTimeout(() => message.delete().catch(() => {}), REJECT_DELETE_MS);
}

export async function handleMessage(message) {
  const channelId = getChannelId();
  if (!channelId) return false;
  if (!message.guild) return false;
  if (message.channel?.id !== channelId) return false;

  if (message.author?.bot) return true;

  if (getMode() === 'sftp') {
    await message.delete().catch(() => {});
    return true;
  }

  // Channel mode below.
  const roleIds = getRoleIds();
  const memberRoles = message.member?.roles?.cache;
  const hasRole = !!memberRoles && roleIds.some((id) => memberRoles.has(id));

  if (!hasRole) {
    log.info({ userId: message.author?.id }, 'Unauthorised post in rotation channel - deleting');
    await message.delete().catch(() => {});
    return true;
  }

  const content = (message.content || '').trim();
  if (!content) {
    await message.delete().catch(() => {});
    return true;
  }

  const { cleanedText, lines } = parseLayerRotation(content);
  if (lines.length === 0) {
    await rejectInvalid(message);
    return true;
  }

  const result = await validateRotation(getSquadUtilsUrl(), cleanedText);
  if (result.fetchError) {
    log.warn({ fetchError: result.fetchError }, 'Squadutils API call failed for channel-posted rotation');
    await rejectInvalid(message);
    return true;
  }
  if (!result.ok) {
    await rejectInvalid(message);
    return true;
  }

  const modeForEmbed = getLastKnownMode() || 'Unknown';
  const hash = hashRotation(modeForEmbed, cleanedText);

  if (hash === getLastValidHash()) {
    await message.delete().catch(() => {});
    return true;
  }

  await message.delete().catch(() => {});
  await replaceLiveEmbed(message.client, { mode: modeForEmbed, lines, source: 'channel' });
  setLastValidHash(hash);
  return true;
}
```

- [ ] **Step 2: Verify the module imports cleanly**

Run: `bun test`
Expected: all 26 tests still pass; no import-side-effect errors.

- [ ] **Step 3: Commit**

```bash
git add src/services/layerRotationValidator/layerRotationChannelHandler.js
git commit -m "feat(layer-rotation): add channel-mode message handler"
```

---

## Task 11: Wire handler into messageCreate

**Files:**
- Modify: `src/events/messageCreate.js`

Insert a call to `handleMessage` at the top of `execute`, before the partial-fetch and bot-author short-circuits. The handler returns `true` when it owns the message, in which case `execute` returns immediately.

- [ ] **Step 1: Add the import**

Open `src/events/messageCreate.js`. Find the import block near the top. Add this import after the other handler imports (after `import * as prospectForumMessages from '../handlers/prospectForumMessages.js';`):

```js
import { handleMessage as handleLayerRotationMessage } from '../services/layerRotationValidator/layerRotationChannelHandler.js';
```

- [ ] **Step 2: Invoke at the top of `execute`**

Inside the `execute` function, immediately after the `if (message.partial) { ... }` block (around line 25–26, after the `try { message = await message.fetch(); ... }` recovery), add:

```js
    try {
      const handled = await handleLayerRotationMessage(message);
      if (handled) return;
    } catch (err) {
      reportError(err, {
        source: 'messageCreate.layerRotation',
        userId: message.author?.id,
        channelId: message.channel?.id,
      }).catch(() => {});
      return;
    }
```

The call must come BEFORE the existing `if (message.author.bot) return;` line, because the handler needs to see bot messages too (to return `true` for our own posts so further routing is skipped — though in practice this is a no-op since our embed channel isn't a ticket/prospect category).

- [ ] **Step 3: Verify nothing regressed**

Run: `bun test`
Expected: all 26 tests still pass.

Static-check the file by importing it:

Run: `bun -e "import('./src/events/messageCreate.js').then(() => console.log('OK'))"`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add src/events/messageCreate.js
git commit -m "feat(layer-rotation): route channel messages to rotation handler"
```

---

## Task 12: Settings entries

**Files:**
- Modify: `settings.production.js`
- Modify: `settings.staging.js`
- Modify: `settings.development.js`

- [ ] **Step 1: Add the prod settings block**

Open `settings.production.js`. Find the existing `configGuardian` block:

```js
configGuardian: {
  channelId: '1490634013503656006',                      // Config Guardian alerts channel
},
```

Insert immediately after it:

```js
layerRotationValidator: {
  enabled: true,
  channelId: '1509632566548889773',                      // Prod: live rotation status channel
  errorRoleIds: ['1225894972084060290', '733974178797191189'],  // Pinged on SFTP-mode errors AND authorised to post in Channel mode
  intervalMs: 5 * 60 * 1000,
  squadUtilsUrl: process.env.SQUAD_UTILS_URL || 'https://squadutils.org/api/v3/parse',
  serverCfgName: 'Server.cfg',
  layerRotationName: 'LayerRotation.cfg',
},
```

- [ ] **Step 2: Add the staging settings block**

Open `settings.staging.js`. Find the existing `configGuardian` block (around line 81). Insert immediately after it:

```js
layerRotationValidator: {
  enabled: false,
},
```

- [ ] **Step 3: Add the development settings block**

Open `settings.development.js`. Search for `configGuardian:`. If present, insert the same `layerRotationValidator: { enabled: false }` block immediately after. If absent, add the block at the same indentation as other top-level keys, immediately before the closing `};`.

- [ ] **Step 4: Verify settings load**

Run: `bun -e "import('./settings.production.js').then(m => console.log('prod OK:', !!m.default.layerRotationValidator))"`
Expected: `prod OK: true`

Run: `bun -e "import('./settings.staging.js').then(m => console.log('staging OK:', m.default.layerRotationValidator.enabled === false))"`
Expected: `staging OK: true`

Run: `bun -e "import('./settings.development.js').then(m => console.log('dev OK:', m.default.layerRotationValidator.enabled === false))"`
Expected: `dev OK: true`

- [ ] **Step 5: Commit**

```bash
git add settings.production.js settings.staging.js settings.development.js
git commit -m "feat(layer-rotation): add per-environment settings"
```

---

## Task 13: Wire scheduler into ready + shutdown

**Files:**
- Modify: `src/events/ready.js`
- Modify: `src/index.js`

- [ ] **Step 1: Add the import + safeInit call in ready.js**

Open `src/events/ready.js`. Find the existing `startConfigGuardian` import (around line 15):

```js
import { startScheduler as startConfigGuardian } from '../services/configGuardian/configGuardianScheduler.js';
```

Insert immediately after it:

```js
import { startScheduler as startLayerRotationValidator } from '../services/layerRotationValidator/layerRotationValidatorScheduler.js';
```

Then find the `safeInit('configGuardian', ...)` line in the `execute` function (around line 51):

```js
await safeInit('configGuardian', () => startConfigGuardian(client));
```

Insert immediately after it:

```js
await safeInit('layerRotationValidator', () => startLayerRotationValidator(client));
```

- [ ] **Step 2: Add the stop import + shutdown call in index.js**

Open `src/index.js`. Find the existing `stopConfigGuardian` import (around line 15):

```js
import { stopScheduler as stopConfigGuardian } from './services/configGuardian/configGuardianScheduler.js';
```

Insert immediately after it:

```js
import { stopScheduler as stopLayerRotationValidator } from './services/layerRotationValidator/layerRotationValidatorScheduler.js';
```

Then find the `stopConfigGuardian();` line in the `shutdown` function (around line 106):

```js
stopConfigGuardian();
```

Insert immediately after it:

```js
stopLayerRotationValidator();
```

- [ ] **Step 3: Verify the bot boots in dev**

Run: `NODE_ENV=development bun run src/index.js`
Wait ~5 seconds for boot. Expected output should include:
- `Initializing database schema...` followed by no error about `layer_rotation_current`.
- `[boot] bot environment` log line.
- `layerRotationValidator disabled in settings - not starting`.
- Bot reaches "online" state without errors.

Press `Ctrl+C`. Expected: clean shutdown.

- [ ] **Step 4: Commit**

```bash
git add src/events/ready.js src/index.js
git commit -m "feat(layer-rotation): wire scheduler into ready and shutdown"
```

---

## Task 14: Live smoke test — SFTP mode

**Files:** None modified.

Run the bot in dev with the validator enabled, pointed at a sandbox channel, in SFTP mode. Confirm: boot-clear, embed post on first valid tick, no-change skip on subsequent ticks, error path to alerts channel.

- [ ] **Step 1: Pick a sandbox channel**

Choose a Discord channel in the dev/staging guild where the bot can post freely. Note its ID. Confirm bot perms: `View Channel`, `Send Messages`, `Manage Messages`, `Embed Links`, `Add Reactions`.

- [ ] **Step 2: Temporarily enable the validator in dev (SFTP mode)**

Open `settings.development.js`. Replace the `layerRotationValidator` block with:

```js
layerRotationValidator: {
  enabled: true,
  channelId: '<SANDBOX_CHANNEL_ID>',
  errorRoleIds: ['<TEST_ROLE_ID>'],   // Any role you can grant yourself for testing
  intervalMs: 60 * 1000,
  squadUtilsUrl: process.env.SQUAD_UTILS_URL || 'https://squadutils.org/api/v3/parse',
  serverCfgName: 'Server.cfg',
  layerRotationName: 'LayerRotation.cfg',
},
```

Also edit `layerRotationValidatorScheduler.js` line `intervalMs: 5 * 60 * 1000,` → `intervalMs: 60 * 1000,` for faster feedback. **Both edits must be reverted before commit.**

Confirm `.env` has `SFTP_*` set, and unset / explicitly set `LAYER_ROTATION_SOURCE=sftp`.

- [ ] **Step 3: Run the bot and observe SFTP mode**

Run: `NODE_ENV=development bun run src/index.js`

Watch for log lines:
- `layerRotationValidator started (..., source=sftp)`
- `Prod channel cleared on boot`
- After a minute: `Posted updated rotation embed` with the layer count
- The sandbox channel shows a green embed with the rotation table

Press `Ctrl+C`.

- [ ] **Step 4: Test the no-change path (SFTP)**

Restart the bot without touching SFTP files. Expected:
- Channel cleared on boot.
- Persisted row restored as the embed (if Step 3 succeeded).
- One success embed visible; subsequent ticks log nothing about reposting.

Press `Ctrl+C`.

- [ ] **Step 5: Test the SFTP error path**

In the bot's running state, manually edit `LayerRotation.cfg` on the server to include a clearly invalid line (e.g. `BogusLayer_Junk_v999 NONE NONE`). Wait one polling interval.

Expected:
- A red error embed in your dev alerts channel pinging the test role.
- Sandbox channel embed unchanged.

Revert the cfg file. Wait one interval. Expected: a new green embed in the sandbox channel; previous green embed deleted.

- [ ] **Step 6: No commit needed**

Smoke-test only. Proceed to Task 15.

---

## Task 15: Live smoke test — Channel mode

**Files:** None modified.

Switch the running bot to Channel mode and verify: bot-only invariant, role-gated posting, valid path, invalid path, duplicate-post path, mode-badge refresh.

- [ ] **Step 1: Set Channel mode and restart**

Set the env var. In PowerShell:
```powershell
$env:LAYER_ROTATION_SOURCE='channel'; NODE_ENV=development bun run src/index.js
```

(Use the equivalent on your shell. Confirm the boot log says `source=channel`.)

- [ ] **Step 2: Test bot-only invariant (no role)**

From a Discord account that does NOT have your test role, post any message in the sandbox channel.
Expected: the message is deleted within ~1s. No reaction. Bot log: `Unauthorised post in rotation channel - deleting`.

- [ ] **Step 3: Test invalid post (with role)**

Grant your test account the test role. Post `obviously not a layer rotation`. Expected:
- ❌ reaction appears within ~3s.
- Message is deleted 30s later.
- No embed change.

- [ ] **Step 4: Test valid post (with role)**

Paste a valid rotation (copy a real LayerRotation.cfg snippet) as a plain message. Expected:
- Your message is deleted within ~3s.
- A new green embed appears in the channel (deletion of the previous one follows).
- Log: `Posted updated rotation embed ... source=channel`.

- [ ] **Step 5: Test duplicate post (with role)**

Re-paste the same content. Expected:
- Your message is deleted.
- The embed does NOT churn (no new embed posted, no deletion).
- No reaction.

- [ ] **Step 6: Test mode-badge refresh**

While the bot runs, manually edit `Server.cfg` on the host to flip the active `MapRotationMode` (e.g. comment out `LayerList_Vote` and uncomment `LayerList`). Wait one interval (60s with the test override).

Expected:
- Existing rotation re-rendered with the new mode badge.
- Old embed deleted, new embed posted.
- Log: `Posted updated rotation embed ... source=channel` (source is preserved from the persisted row).

Revert the Server.cfg edit.

- [ ] **Step 7: Test SFTP-mode delete in cross-mode scenario**

Stop the bot. Switch back to SFTP mode (unset `LAYER_ROTATION_SOURCE` or set to `sftp`). Restart.

Post any message in the sandbox channel (from any account, with or without role). Expected: silent delete.

- [ ] **Step 8: Revert the dev edits**

Revert `settings.development.js` to:
```js
layerRotationValidator: { enabled: false },
```

Revert `layerRotationValidatorScheduler.js` `intervalMs` back to `5 * 60 * 1000`.

Confirm:
```bash
git diff settings.development.js src/services/layerRotationValidator/layerRotationValidatorScheduler.js
```
Shows no changes after the revert.

- [ ] **Step 9: No commit needed**

Smoke-test only. Nothing to ship.

---

## Self-review notes

- **Spec coverage:**
  - SFTP-mode flow → Tasks 2,3,4,5,6,7,9 (the tick path in scheduler).
  - Channel-mode flow → Tasks 9 (mode-tick), 10 (handler), 11 (wiring).
  - Persistence → Task 8 (schema + helpers), Task 9 (`replaceLiveEmbed` upsert + restoreFromPersistence on boot).
  - Embed shape, prettifier, table → Tasks 4,5,6.
  - Error post with role pings → Task 9 `postError`.
  - Channel error path (❌ + 30s delete) → Task 10 `rejectInvalid`.
  - Settings + env vars → Task 12 + scheduler's `LAYER_ROTATION_SOURCE` read in Task 9.
  - Wiring → Tasks 11 and 13.
- **Placeholder scan:** None. Every step has either complete code or an explicit command with expected output.
- **Type consistency:** `parseLayerRotation` returns `{ cleanedText, lines }`; consumers in Tasks 9 and 10 destructure both. `validateRotation` returns `{ ok, errors, fetchError? }`; consumers branch on `result.ok` and `result.fetchError`. `replaceLiveEmbed({ mode, lines, source })` signature matches all call sites: SFTP tick, Channel handler, restore-from-persistence, mode-refresh tick. `readPersistedRotation()` returns `{ cleanedText, mode, source }` — note that Task 9 reads it via `row.cleaned_text || row.cleanedText` to handle MariaDB's snake_case column response shape; if the helper post-processes to camelCase, the fallback is harmless.
- **DB row shape note:** The MariaDB connector returns columns as `snake_case` keys by default. Task 8's `readPersistedRotation` translates to `{ cleanedText, mode, source }`, but Task 9's restore/refresh code defensively reads both forms in case of refactor drift. Acceptable belt-and-suspenders.
- **Cross-module accessor pattern:** Channel handler imports `getMode/getChannelId/...` from the scheduler module instead of duplicating settings reads. Single source of truth: settings flow through `getSettings()` in the scheduler.
- **Mode switch race:** None. `LAYER_ROTATION_SOURCE` is read once at `startScheduler`; the handler's `getMode()` returns the same value. To flip modes, restart.
- **Test coverage:** Pure parsers/prettifier/formatter unit-tested (~22 cases). Service-level boundaries (SFTP/HTTP/DB) and scheduler/handler orchestration are smoke-tested in Tasks 14–15. Adding mock-based unit tests for the orchestrators would be useful long-term but is out of scope for v1.
