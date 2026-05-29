# Layer Rotation Validator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-validate the Squad server's layer rotation against squadutils.org every 5 minutes by fetching `Server.cfg` and `LayerRotation.cfg` from SFTP, posting a single live status embed to channel `1509632566548889773` on change, and role-pinging the alerts channel on parser errors.

**Architecture:** New self-contained service at `src/services/layerRotationValidator/` (three JS files + tests). Reuses the existing `ssh2-sftp-client` dependency and `createScheduler` utility. Independent SFTP fetch (two files only), independent message-lifecycle state, independent of `ConfigGuardian`. In-memory state for live-message id; aggressive channel-clear on boot rebuilds state from scratch.

**Tech Stack:** Bun (built-in `bun test`), discord.js v14, `ssh2-sftp-client`, native `fetch` + `AbortController`, native `crypto.createHash`, Pino logger.

**Spec reference:** `docs/superpowers/specs/2026-05-28-layer-rotation-validator-design.md`

---

## File Structure

**New files:**
- `src/services/layerRotationValidator/layerRotationValidatorService.js` — SFTP fetch, cfg parsing, squadutils API call. Pure functions for parsers; thin orchestration for SFTP/HTTP. **No state.**
- `src/services/layerRotationValidator/layerRotationValidatorEmbeds.js` — `buildSuccessEmbed`, `buildErrorEmbed`, layer-token prettifier, table formatter. **No state.**
- `src/services/layerRotationValidator/layerRotationValidatorScheduler.js` — `startScheduler`, `stopScheduler`. Holds module-scoped state: `liveMessageId`, `lastValidHash`, `lastErrorHash`, `resolvedServerCfgName`.
- `src/services/layerRotationValidator/__tests__/parser.test.js` — unit tests for parsers and prettifier.
- `src/services/layerRotationValidator/__tests__/formatter.test.js` — unit tests for table formatter.

**Modified files:**
- `package.json` — add `test` script.
- `settings.production.js` — add `layerRotationValidator` config block.
- `settings.staging.js` — add disabled stub.
- `settings.development.js` — add disabled stub.
- `src/events/ready.js` — wire `startScheduler` into the `ClientReady` chain.
- `src/index.js` — import + invoke `stopScheduler` in the `shutdown` handler.

---

## Task 1: Add bun:test runner script

**Files:**
- Modify: `package.json`

This codebase has no existing tests. Bun has a built-in test runner; no new dependency is needed. We just need a script entry so the runner is discoverable.

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

- [ ] **Step 2: Verify the runner finds no tests (yet)**

Run: `bun test`
Expected output (paraphrased): `0 pass | 0 fail | 0 expect() calls`. Exit code 0.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore(test): add bun test script"
```

---

## Task 2: parseMapRotationMode (cfg parser)

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
Expected: every test fails with a module-resolution or "parseMapRotationMode is not a function" error (the implementation file doesn't exist yet).

- [ ] **Step 3: Write the minimal implementation**

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

## Task 3: parseLayerRotation (cfg parser)

**Files:**
- Modify: `src/services/layerRotationValidator/__tests__/parser.test.js`
- Modify: `src/services/layerRotationValidator/layerRotationValidatorService.js`

Strip blank lines and comments from `LayerRotation.cfg`, returning `{ cleanedText, lines }`. `cleanedText` is what we send to the squadutils API. `lines` is the per-layer string array consumed by the embed builder.

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
Expected: the new `describe('parseLayerRotation', ...)` block's 5 tests fail with "parseLayerRotation is not a function". The Task 2 tests still pass.

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

Tokenize a layer string like `FoolsRoad_RAAS_v1 AFU RGF` into a row object:
```
{ map: 'Fools Road', variant: 'RAAS v1', team1: 'AFU', team2: 'RGF' }
```

Rules:
- Split each cfg line on whitespace. First element is the layer token, second is team 1, third is team 2.
- Tokenize the layer token on `_`. If the last segment matches `^v\d+$`, treat it as the version and the segment before it as the mode. Otherwise, the last segment is the mode and version is empty.
- Map name = everything before the mode segment, joined.
- Prettify map name: insert a space before every uppercase letter except the first character. So `FoolsRoad` → `Fools Road`, `BlackCoast` → `Black Coast`. Single-word names like `Sumari` stay unchanged.
- Variant = `mode` + (` ${version}` if present), e.g. `RAAS v1`, `TC v1`. Empty version → just the mode.
- Team strings: split on `+`, join with ` + `. Missing team → `-`.
- Malformed input (layer token doesn't tokenize) → render raw token in `map`, empty `variant`, teams still parsed.

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

  test('handles missing version (no _vN suffix)', () => {
    expect(prettifyLayerToken('Sumari_RAAS USA MEI')).toEqual({
      map: 'Sumari', variant: 'RAAS', team1: 'USA', team2: 'MEI',
    });
  });

  test('handles multi-segment map names', () => {
    // Hypothetical: Map_With_Underscores_RAAS_v1
    expect(prettifyLayerToken('Black_Coast_RAAS_v1 PLA CAF')).toEqual({
      map: 'Black Coast', variant: 'RAAS v1', team1: 'PLA', team2: 'CAF',
    });
  });

  test('falls back gracefully on a single-token layer (no underscores)', () => {
    expect(prettifyLayerToken('SomeRawToken USA MEI')).toEqual({
      map: 'SomeRawToken', variant: '', team1: 'USA', team2: 'MEI',
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/services/layerRotationValidator/__tests__/parser.test.js`
Expected: the 8 `prettifyLayerToken` tests fail because `layerRotationValidatorEmbeds.js` doesn't exist yet.

- [ ] **Step 3: Implement prettifyLayerToken**

Create `src/services/layerRotationValidator/layerRotationValidatorEmbeds.js`:

```js
const VERSION_RE = /^v\d+$/i;

function splitCamelCase(s) {
  // Insert a space before every uppercase letter that follows a lowercase letter.
  return s.replace(/([a-z])([A-Z])/g, '$1 $2');
}

function joinMapSegments(segments) {
  // Each segment is prettified separately, then joined with a single space.
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

## Task 5: Rotation table formatter

**Files:**
- Create: `src/services/layerRotationValidator/__tests__/formatter.test.js`
- Modify: `src/services/layerRotationValidator/layerRotationValidatorEmbeds.js`

Given an array of cfg lines, return a fenced code-block string containing a 5-column aligned table: `#`, `Map`, `Variant`, `Team 1`, `Team 2`. Column widths computed from data. Headers are part of the table. No outer ``` fences in the function output — the caller adds them.

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
    // All non-empty rows share the same length (column alignment).
    const widths = rows.filter(Boolean).map((r) => r.length);
    expect(new Set(widths).size).toBe(1);
  });

  test('renders missing teams as -', () => {
    const lines = ['Mestia_TC_v1'];
    const out = formatRotationTable(lines);
    expect(out).toMatch(/Mestia\s+TC v1\s+-\s+-/);
  });

  test('right-pads numeric index to fit the highest row number', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `Sumari_RAAS_v1 USA MEI`);
    const out = formatRotationTable(lines);
    const rows = out.split('\n').filter(Boolean);
    // Header + 12 rows = 13 lines, all the same length
    expect(rows.length).toBe(13);
    // The two-digit row "12" should align with the single-digit rows.
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
function padRight(s, width) {
  return s + ' '.repeat(Math.max(0, width - s.length));
}

function padLeft(s, width) {
  return ' '.repeat(Math.max(0, width - s.length)) + s;
}

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
Expected: all 26 tests pass (the formatter tests + everything previous).

- [ ] **Step 5: Commit**

```bash
git add src/services/layerRotationValidator/
git commit -m "feat(layer-rotation): add rotation table formatter"
```

---

## Task 6: Embed builders (success + error)

**Files:**
- Modify: `src/services/layerRotationValidator/layerRotationValidatorEmbeds.js`

Two functions:
- `buildSuccessEmbed({ mode, lines })` → `EmbedBuilder` (green, table in description).
- `buildErrorEmbed({ errors })` → `EmbedBuilder` (red, lists each error formatted as `Line <N>: <content> - <error>`).

No tests for these — they're thin wrappers around discord.js. Smoke-tested live in Task 11.

- [ ] **Step 1: Append the embed builders**

Append to `src/services/layerRotationValidator/layerRotationValidatorEmbeds.js`:

```js
import { EmbedBuilder } from 'discord.js';

const COLOR_OK = 0x57F287;
const COLOR_ERR = 0xED4245;
const FOOTER = 'Validated via squadutils.org';

function modeLabel(mode) {
  if (mode === 'LayerList_Vote') return 'LayerList_Vote (players vote)';
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
  // squadutils.org returns: [{ line: number, content: string, error: string }, ...]
  const safeErrors = Array.isArray(errors) ? errors : [];
  const lines = safeErrors.map((e) =>
    `Line ${e.line}: ${e.content} - ${e.error}`
  );
  const body = lines.length > 0 ? lines.join('\n') : 'No error detail returned.';
  // Discord description cap is 4096; truncate defensively.
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
Expected: all 26 tests still pass (no regressions from the new imports/exports).

- [ ] **Step 3: Commit**

```bash
git add src/services/layerRotationValidator/layerRotationValidatorEmbeds.js
git commit -m "feat(layer-rotation): add success and error embed builders"
```

---

## Task 7: SFTP fetch + squadutils API call

**Files:**
- Modify: `src/services/layerRotationValidator/layerRotationValidatorService.js`

Adds three exports:
- `fetchCfgFiles(sftpConfig, { serverCfgName, layerRotationName, cachedServerCfgName })` → `{ serverCfgText, layerRotationText, resolvedServerCfgName }`. Tries `serverCfgName` first; on "No such file" tries `layerRotationName`'s parent path lowercased filename. Uses a single SFTP connection per call.
- `validateRotation(squadUtilsUrl, cleanedText)` → `{ ok: true, errors: [] }` | `{ ok: false, errors: [...] }` | `{ ok: false, errors: null, fetchError: '...' }`. 15s timeout via `AbortController`. Accepts 200/422 as parseable; everything else is `fetchError`.
- `hashRotation(mode, cleanedText)` → SHA-1 hex string.

No unit tests (boundary code). Smoke-tested in Task 11.

- [ ] **Step 1: Append SFTP fetch + API + hash helpers**

Append to `src/services/layerRotationValidator/layerRotationValidatorService.js`:

```js
import SftpClient from 'ssh2-sftp-client';
import { createHash } from 'crypto';

export async function fetchCfgFiles(sftpConfig, { serverCfgName, layerRotationName, cachedServerCfgName }) {
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
      const tried = namesToTry.join(', ');
      throw new Error(`Server cfg not found (tried: ${tried})`);
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
  const norm = safe
    .map((e) => `${e.line}|${e.content}|${e.error}`)
    .sort()
    .join('\n');
  return createHash('sha1').update(norm).digest('hex');
}
```

- [ ] **Step 2: Verify the project still loads**

Run: `bun test`
Expected: all 26 tests still pass. (The new code isn't unit-tested but importing `ssh2-sftp-client` at module-load shouldn't break anything — it's already a dependency.)

- [ ] **Step 3: Commit**

```bash
git add src/services/layerRotationValidator/layerRotationValidatorService.js
git commit -m "feat(layer-rotation): add SFTP fetch and squadutils API client"
```

---

## Task 8: Scheduler with channel-clear and live-message lifecycle

**Files:**
- Create: `src/services/layerRotationValidator/layerRotationValidatorScheduler.js`

The orchestration layer. Holds module-scoped state. Reuses `createScheduler`. Boot path: clear channel → first tick. Each tick: validate config → fetch SFTP → parse → hash → validate API → branch (no-op / success post / error post).

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
} from './layerRotationValidatorService.js';
import { buildSuccessEmbed, buildErrorEmbed } from './layerRotationValidatorEmbeds.js';
import { reportError } from '../admin/errorAlertService.js';

const log = logger.child({ module: 'layerRotationValidator' });

const VALID_MODES = new Set(['LayerList', 'LayerList_Vote']);

let liveMessageId = null;
let lastValidHash = null;
let lastErrorHash = null;
let resolvedServerCfgName = null;
let booted = false;
let warnedAboutUnusedMode = false;
let warnedAboutCfgMissing = false;

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
    user,
    pass,
    path,
  };
}

async function clearChannel(client, channelId) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    log.warn({ channelId }, 'Prod channel not found - skipping clear');
    return;
  }
  try {
    const messages = await channel.messages.fetch({ limit: 100 });
    if (messages.size === 0) return;
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
    log.info({ channelId }, 'Prod channel cleared on boot');
  } catch (err) {
    log.warn({ err }, 'Channel clear failed (continuing)');
  }
}

async function postSuccess(client, settings, { mode, lines }) {
  const channel = await client.channels.fetch(settings.channelId).catch(() => null);
  if (!channel) {
    log.error({ channelId: settings.channelId }, 'Cannot fetch prod channel for success post');
    return;
  }
  const embed = buildSuccessEmbed({ mode, lines });
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
}

async function postError(client, settings, errors) {
  // Build the alerts-channel message directly because errorAlertService doesn't support content/mentions.
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

async function tick(client) {
  const settings = getSettings();
  if (!settings?.enabled || !settings.channelId) return;

  const sftpConfig = getSftpConfig();
  if (!sftpConfig) {
    if (!warnedAboutCfgMissing) {
      log.warn('SFTP env vars missing - layer rotation validator inactive');
      warnedAboutCfgMissing = true;
    }
    return;
  }

  if (!booted) {
    await clearChannel(client, settings.channelId);
    booted = true;
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

  const mode = parseMapRotationMode(cfgs.serverCfgText);
  if (!VALID_MODES.has(mode)) {
    if (!warnedAboutUnusedMode) {
      log.warn({ mode }, 'MapRotationMode is not LayerList or LayerList_Vote - skipping');
      warnedAboutUnusedMode = true;
    }
    return;
  }
  warnedAboutUnusedMode = false;

  const { cleanedText, lines } = parseLayerRotation(cfgs.layerRotationText);
  const hash = hashRotation(mode, cleanedText);
  if (hash === lastValidHash) return;

  const result = await validateRotation(
    settings.squadUtilsUrl || process.env.SQUAD_UTILS_URL || 'https://squadutils.org/api/v3/parse',
    cleanedText,
  );

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
  await postSuccess(client, settings, { mode, lines });
  log.info({ mode, layers: lines.length }, 'Posted updated rotation embed');
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
  // Override interval if explicitly set.
  const customMs = settings.intervalMs;
  if (typeof customMs === 'number' && customMs > 0 && customMs !== scheduler._intervalMs) {
    // createScheduler doesn't expose runtime override; we just use the default and log if it differs.
    log.info({ requested: customMs, using: 5 * 60 * 1000 }, 'Using compiled-in 5-minute interval (settings override ignored)');
  }
  scheduler.start(client);
  log.info('layerRotationValidator started (5-minute polling)');
}

export function stopScheduler() {
  scheduler.stop();
  liveMessageId = null;
  lastValidHash = null;
  lastErrorHash = null;
  resolvedServerCfgName = null;
  booted = false;
  warnedAboutUnusedMode = false;
  warnedAboutCfgMissing = false;
}

// Test-only: reset internal state. Not part of the public API.
export function __resetForTests() { stopScheduler(); }
```

- [ ] **Step 2: Verify the module imports cleanly**

Run: `bun test`
Expected: all 26 unit tests still pass; no import errors raised on the new file.

- [ ] **Step 3: Commit**

```bash
git add src/services/layerRotationValidator/layerRotationValidatorScheduler.js
git commit -m "feat(layer-rotation): add scheduler with channel-clear and message lifecycle"
```

---

## Task 9: Settings entries

**Files:**
- Modify: `settings.production.js`
- Modify: `settings.staging.js`
- Modify: `settings.development.js`

Production: enabled, prod channel id, role mentions. Staging & development: stubbed disabled.

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
  errorRoleIds: ['1225894972084060290', '733974178797191189'],  // Pinged when rotation has errors
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

Open `settings.development.js`. Find the `configGuardian` block if present (search for `configGuardian:`). Insert immediately after it:

```js
layerRotationValidator: {
  enabled: false,
},
```

If `configGuardian` is not present in `settings.development.js`, add the `layerRotationValidator` block at the same indentation as other top-level keys (immediately before the closing `};`).

- [ ] **Step 4: Verify the settings still load**

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

## Task 10: Wire into ready + shutdown

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

- [ ] **Step 3: Verify the bot still boots in dev**

Run: `NODE_ENV=development bun run src/index.js`
Wait ~5 seconds for the boot sequence to complete.
Expected output should include:
- `[boot] bot environment` log line
- `layerRotationValidator disabled in settings - not starting` (because development settings have `enabled: false`)
- Bot reaches "online" state without errors.

Press `Ctrl+C` to shut down. Expected: clean shutdown, no errors mentioning `layerRotationValidator`.

- [ ] **Step 4: Commit**

```bash
git add src/events/ready.js src/index.js
git commit -m "feat(layer-rotation): wire scheduler into ready and shutdown"
```

---

## Task 11: Live smoke test (manual)

**Files:** None modified.

Run the bot in dev with the validator temporarily enabled, pointed at a sandbox channel, and confirm the end-to-end flow against the real squadutils.org and your real SFTP host.

- [ ] **Step 1: Pick a sandbox channel**

Choose (or create) a Discord channel in the dev/staging guild where you can let the bot post freely. Note its ID. Confirm the bot has `View Channel`, `Send Messages`, `Manage Messages` (for `bulkDelete`), and `Embed Links` permissions there.

- [ ] **Step 2: Temporarily enable the validator in dev**

Open `settings.development.js`. Replace the `layerRotationValidator` block with:

```js
layerRotationValidator: {
  enabled: true,
  channelId: '<SANDBOX_CHANNEL_ID>',
  errorRoleIds: [],     // No pings during smoke test
  intervalMs: 60 * 1000,  // 1-minute polling for faster feedback during the test
  squadUtilsUrl: process.env.SQUAD_UTILS_URL || 'https://squadutils.org/api/v3/parse',
  serverCfgName: 'Server.cfg',
  layerRotationName: 'LayerRotation.cfg',
},
```

**Do not commit this change** — it's only for the manual test.

Also confirm in your local `.env`: `SFTP_HOST`, `SFTP_PORT`, `SFTP_USER`, `SFTP_PASS`, `SFTP_PATH` are set to values that can reach the live server.

> Note: the scheduler's compiled-in interval is `5 * 60 * 1000`. The `intervalMs` setting is informational (the scheduler logs but doesn't override). If you need a faster interval for testing, also edit the `intervalMs: 5 * 60 * 1000` literal in `layerRotationValidatorScheduler.js` to `60 * 1000`, but revert it before committing.

- [ ] **Step 3: Run the bot and observe**

Run: `NODE_ENV=development bun run src/index.js`

Watch for the log lines:
- `Prod channel cleared on boot` (or `Prod channel not found` if your IDs are wrong)
- `Posted updated rotation embed` with the layer count
- The sandbox channel shows a green embed with the rotation table

Press `Ctrl+C` to shut down.

- [ ] **Step 4: Test the no-change path**

Restart the bot without changing the SFTP files. Expected:
- Channel is cleared again on boot.
- One success embed is posted.
- Subsequent ticks log nothing about reposting (the hash matches `lastValidHash`).

Press `Ctrl+C` to shut down.

- [ ] **Step 5: Test the error path**

In the bot's running state, manually break `LayerRotation.cfg` on the server (e.g. introduce a typo like `Sumari_Seed_v999 XXX YYY` on one line via your usual SFTP tool). Wait one polling interval.

Expected:
- A red error embed in your alerts channel (whichever channel is configured as `config.alerts.channelId` in `settings.development.js`).
- No change to the live embed in the sandbox channel (the last known-good embed stays put).

Restore the file. Wait one polling interval.

Expected:
- A new green embed in the sandbox channel.
- Previous green embed deleted.

- [ ] **Step 6: Revert the dev settings**

Restore `settings.development.js` to:

```js
layerRotationValidator: {
  enabled: false,
},
```

Confirm `git diff settings.development.js` shows no changes after the revert.

- [ ] **Step 7: No commit needed for this task**

Smoke-test only. Nothing to ship.

---

## Self-review notes (run during plan authoring)

- **Spec coverage:** Every section of the spec maps to a task — parsers (Task 2-3), prettifier (Task 4), table (Task 5), embeds (Task 6), SFTP+API+hashing (Task 7), scheduler with channel-clear + message lifecycle + error post + role pings + dedupe (Task 8), per-env settings (Task 9), wiring (Task 10), live verification (Task 11).
- **Placeholders:** None. Every step has either complete code or an exact command + expected output.
- **Type consistency:** `parseLayerRotation` returns `{ cleanedText, lines }` in Task 3 and that same shape is consumed in Task 8. `validateRotation` returns `{ ok, errors, fetchError? }` in Task 7 and consumers in Task 8 branch on `result.ok` and `result.fetchError`. `prettifyLayerToken` returns `{ map, variant, team1, team2 }` and `formatRotationTable` consumes the same shape via `prettifyLayerToken`. `hashRotation(mode, cleanedText)` matches the call site `hashRotation(mode, cleanedText)`. `hashErrors(errors)` matches the call site `hashErrors(result.errors)`.
- **Spec drift flagged:** The spec says "Wired in `src/index.js` next to `configGuardianScheduler.startScheduler(client)`" — actually the bot's `startScheduler` wiring lives in `src/events/ready.js`. The plan reflects the real codebase in Task 10. `index.js` only handles shutdown.
- **Aggressive bulkDelete on boot:** Confirmed in code that the prod channel is treated as single-purpose status surface (per user). Pattern copied from `seedingScheduler.resetChannel`.
- **Scheduler.intervalMs override caveat:** `createScheduler` captures `intervalMs` at construction time and the returned object doesn't expose a setter. The plan acknowledges this in Step 2 of Task 11 — settings.intervalMs is informational; the 5-minute literal in the scheduler file is the source of truth. This is acceptable because the design only ever uses 5 minutes; the setting exists as a documented hook.
