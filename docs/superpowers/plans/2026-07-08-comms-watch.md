# Comms Watch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface members/prospects who are in-game on the Squad server but not on Discord voice — via a staff live board and a background prospect-alert watcher.

**Architecture:** One always-on `createScheduler` tick (~60s) pulls the Main live roster (`seedingSocket.getServerStateByName`) ∪ the guild voice cache, runs each tracked person through a pure debounced state machine (`evaluateComms`), persists per-identity state in `comms_watch_state`, then feeds two consumers: the staff board embed and the prospect alerter. A staff slash command posts/moves the single board panel.

**Tech Stack:** Bun, discord.js v14, MariaDB (`mariadb` pool), Pino, `bun:test`.

## Global Constraints

- ESM only; parameterized queries only (`?`).
- Semantic version bump on push: `2.30.2` → `2.31.0` (package.json).
- Conventional Commits, one-line, no AI attribution, no emojis.
- Times inside the pure logic are epoch **ms**; DB stores them as `BIGINT`.
- "On Discord" = in any voice channel except `guild.afkChannelId` (config override `afkChannelId`); mute/deafen ignored.
- Enabled in all envs via `config.commsWatch.enabled` (default true); Main only (`serverName`), config-driven.
- New slash command needs manual `deploy-commands` per env after deploy.

## File Structure

- Create `src/services/commsWatch/commsWatchState.js` — pure: `evaluateComms`, `classifyKind`, `formatDuration`.
- Create `src/services/commsWatch/__tests__/commsWatchState.test.js` — unit tests.
- Create `src/services/commsWatch/commsWatchEmbeds.js` — `buildBoardEmbed`, `buildProspectAlertEmbed`.
- Create `src/services/commsWatch/__tests__/commsWatchEmbeds.test.js` — unit tests.
- Create `src/services/commsWatch/commsWatchService.js` — DB + identity resolution + board pointer.
- Create `src/services/commsWatch/commsWatchMonitor.js` — scheduler tick, `runMonitorTick`, `refreshBoard`, `buildCurrentBoardEmbed`, start/stop.
- Create `src/commands/comms-board.js` — staff slash command (`show`/`stop`).
- Modify `src/database/schema.js` — add `comms_watch_state` table.
- Modify `src/events/ready.js` — start the scheduler.
- Modify `settings.production.js`, `settings.staging.js`, `settings.development.js` — add `commsWatch` block.
- Modify `package.json` — version bump.

---

### Task 1: Pure state machine + tests

**Files:**
- Create: `src/services/commsWatch/commsWatchState.js`
- Test: `src/services/commsWatch/__tests__/commsWatchState.test.js`

**Interfaces:**
- Produces:
  - `evaluateComms(prev, obs, now, { graceMs, thresholdMs })` → next-state object with fields `{ observedInVoice, voiceChangedAt, commsOk, offCommsSince, inGameSince, alerted, isOffComms, offCommsMs, shouldAlert }`. The return is a superset of `prev`, so it can be fed straight back as the next `prev`.
  - `classifyKind(steamId, { prospectSteamIds, memberSteamIds })` → `'prospect' | 'member' | null` (prospect priority).
  - `formatDuration(ms)` → e.g. `'0m'`, `'14m'`, `'1h 2m'`, `'2h'`.

- [ ] **Step 1: Write failing tests** (`commsWatchState.test.js`):

```js
import { describe, test, expect } from 'bun:test';
import { evaluateComms, classifyKind, formatDuration } from '../commsWatchState.js';

const OPTS = { graceMs: 60000, thresholdMs: 900000 };
const inGameOff = { inGame: true, inVoice: false };
const inGameOn = { inGame: true, inVoice: true };
const step = (prev, obs, now) => evaluateComms(prev, obs, now, OPTS);

describe('evaluateComms - grace on first sighting', () => {
  test('never in voice: not flagged until grace, then off-comms with growing duration', () => {
    const t0 = step({}, inGameOff, 0);
    expect(t0.isOffComms).toBe(false);          // within initial grace
    expect(t0.commsOk).toBe(null);
    const t1 = step(t0, inGameOff, 60000);
    expect(t1.isOffComms).toBe(true);
    expect(t1.offCommsMs).toBe(60000);
    const t2 = step(t1, inGameOff, 120000);
    expect(t2.offCommsMs).toBe(120000);
  });
});

describe('evaluateComms - blip grace', () => {
  test('brief voice drop (< grace) stays compliant', () => {
    let s = step({}, inGameOn, 0);
    s = step(s, inGameOn, 60000);       // stable in voice -> commsOk true
    expect(s.commsOk).toBe(true);
    const drop = step(s, inGameOff, 70000);   // 10s drop
    expect(drop.commsOk).toBe(true);
    expect(drop.isOffComms).toBe(false);
    const back = step(drop, inGameOn, 80000);
    expect(back.commsOk).toBe(true);
  });

  test('brief voice join (< grace) during an episode does NOT reset the timer', () => {
    let s = step({}, inGameOff, 0);
    s = step(s, inGameOff, 60000);      // off-comms, offCommsSince=0
    expect(s.offCommsSince).toBe(0);
    const join = step(s, inGameOn, 120000);   // brief join
    expect(join.isOffComms).toBe(true);
    expect(join.offCommsSince).toBe(0);
    expect(join.offCommsMs).toBe(120000);
  });

  test('sustained rejoin (>= grace) clears the episode and re-arms', () => {
    let s = step({}, inGameOff, 0);
    s = step(s, inGameOff, 60000);
    s = step(s, inGameOn, 120000);      // join starts
    const rejoined = step(s, inGameOn, 180000); // 60s in voice
    expect(rejoined.commsOk).toBe(true);
    expect(rejoined.isOffComms).toBe(false);
    expect(rejoined.offCommsSince).toBe(null);
  });
});

describe('evaluateComms - alerting', () => {
  test('crossing threshold alerts once, then dedupes', () => {
    let s = step({}, inGameOff, 0);
    s = step(s, inGameOff, 60000);
    s = step(s, inGameOff, 900000);
    expect(s.shouldAlert).toBe(true);
    expect(s.alerted).toBe(true);
    const later = step(s, inGameOff, 960000);
    expect(later.shouldAlert).toBe(false);
  });

  test('leaving the game resets state and re-arms', () => {
    let s = step({}, inGameOff, 0);
    s = step(s, inGameOff, 900000);
    expect(s.alerted).toBe(true);
    const left = step(s, { inGame: false, inVoice: false }, 960000);
    expect(left.isOffComms).toBe(false);
    expect(left.alerted).toBe(false);
    expect(left.inGameSince).toBe(null);
  });
});

describe('classifyKind', () => {
  const sets = { prospectSteamIds: new Set(['P']), memberSteamIds: new Set(['M', 'P']) };
  test('prospect takes priority', () => expect(classifyKind('P', sets)).toBe('prospect'));
  test('member when only member', () => expect(classifyKind('M', sets)).toBe('member'));
  test('null when neither / no id', () => {
    expect(classifyKind('X', sets)).toBe(null);
    expect(classifyKind(null, sets)).toBe(null);
  });
});

describe('formatDuration', () => {
  test('formats', () => {
    expect(formatDuration(30000)).toBe('0m');
    expect(formatDuration(840000)).toBe('14m');
    expect(formatDuration(3720000)).toBe('1h 2m');
    expect(formatDuration(7200000)).toBe('2h');
  });
});
```

- [ ] **Step 2: Run tests, verify fail** — `bun test src/services/commsWatch/__tests__/commsWatchState.test.js` → FAIL (module missing).

- [ ] **Step 3: Implement `commsWatchState.js`**:

```js
// Pure comms state machine. All times are epoch ms. No I/O, no Date.now().
export function evaluateComms(prev, obs, now, { graceMs, thresholdMs }) {
  if (!obs.inGame) {
    return {
      observedInVoice: null, voiceChangedAt: null, commsOk: null,
      offCommsSince: null, inGameSince: null, alerted: false,
      isOffComms: false, offCommsMs: 0, shouldAlert: false,
    };
  }

  const inGameSince = prev.inGameSince ?? now;

  let observedInVoice = prev.observedInVoice;
  let voiceChangedAt = prev.voiceChangedAt;
  if (observedInVoice === null || observedInVoice === undefined || observedInVoice !== obs.inVoice) {
    observedInVoice = obs.inVoice;
    voiceChangedAt = now;
  }
  const stableFor = now - voiceChangedAt;

  let commsOk = prev.commsOk ?? null;
  if (stableFor >= graceMs) commsOk = obs.inVoice;

  let offCommsSince = prev.offCommsSince ?? null;
  let alerted = prev.alerted ?? false;
  if (commsOk === true) {
    offCommsSince = null;
    alerted = false;
  } else if (commsOk === false) {
    offCommsSince = offCommsSince ?? voiceChangedAt;
  } else {
    offCommsSince = null;
  }

  const isOffComms = commsOk === false && offCommsSince != null;
  const offCommsMs = isOffComms ? now - offCommsSince : 0;
  const shouldAlert = isOffComms && offCommsMs >= thresholdMs && !alerted;
  if (shouldAlert) alerted = true;

  return { observedInVoice, voiceChangedAt, commsOk, offCommsSince, inGameSince, alerted, isOffComms, offCommsMs, shouldAlert };
}

export function classifyKind(steamId, { prospectSteamIds, memberSteamIds }) {
  if (!steamId) return null;
  if (prospectSteamIds.has(steamId)) return 'prospect';
  if (memberSteamIds.has(steamId)) return 'member';
  return null;
}

export function formatDuration(ms) {
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
```

- [ ] **Step 4: Run tests, verify pass** — same command → PASS.
- [ ] **Step 5: Commit** — `git add` the two files; `git commit -m "feat(comms-watch): add pure comms state machine"`.

---

### Task 2: Embeds + tests

**Files:**
- Create: `src/services/commsWatch/commsWatchEmbeds.js`
- Test: `src/services/commsWatch/__tests__/commsWatchEmbeds.test.js`

**Interfaces:**
- Consumes: `formatDuration` (Task 1), `createEmbed` (`src/utils/embed.js`).
- Produces:
  - `buildBoardEmbed(violators, serverName, now)` → EmbedBuilder. `violators`: `[{ discordId, name, kind, offCommsMs }]`.
  - `buildProspectAlertEmbed({ userId, alias }, offCommsSince, offCommsMs, serverName)` → EmbedBuilder.

- [ ] **Step 1: Failing tests**:

```js
import { describe, test, expect } from 'bun:test';
import { buildBoardEmbed, buildProspectAlertEmbed } from '../commsWatchEmbeds.js';

describe('buildBoardEmbed', () => {
  test('empty state is green and says everyone on comms', () => {
    const e = buildBoardEmbed([], 'Main', 0).toJSON();
    expect(e.color).toBe(0x57f287);
    expect(e.description).toContain('on comms');
    expect(e.title).toContain('Main');
  });
  test('violators listed newest-longest first with mention, name, duration, tag', () => {
    const e = buildBoardEmbed([
      { discordId: '1', name: 'Alpha', kind: 'member', offCommsMs: 120000 },
      { discordId: '2', name: 'Bravo', kind: 'prospect', offCommsMs: 900000 },
    ], 'Main', 0).toJSON();
    expect(e.color).toBe(0xfee75c);
    const firstIdx = e.description.indexOf('<@2>');
    const secondIdx = e.description.indexOf('<@1>');
    expect(firstIdx).toBeLessThan(secondIdx);   // 15m before 2m
    expect(e.description).toContain('`Bravo`');
    expect(e.description).toContain('[Prospect]');
    expect(e.description).toContain('[Member]');
  });
});

describe('buildProspectAlertEmbed', () => {
  test('mentions the prospect and includes since + duration', () => {
    const e = buildProspectAlertEmbed({ userId: '99', alias: 'Zed' }, 0, 900000, 'Main').toJSON();
    expect(e.description).toContain('<@99>');
    expect(e.description).toContain('Zed');
    expect(e.description).toContain('Main');
    const names = e.fields.map((f) => f.name);
    expect(names).toContain('Since');
    expect(names).toContain('Duration');
  });
});
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement `commsWatchEmbeds.js`**:

```js
import { createEmbed } from '../../utils/embed.js';
import { formatDuration } from './commsWatchState.js';

export function buildBoardEmbed(violators, serverName, now) {
  const embed = createEmbed('Comms').setTitle(`Playing without Discord — ${serverName}`);
  const updated = `Updated <t:${Math.floor(now / 1000)}:R>`;
  if (!violators.length) {
    return embed.setColor(0x57f287).setDescription(`Everyone in-game is on comms.\n\n${updated}`);
  }
  const lines = violators
    .slice()
    .sort((a, b) => b.offCommsMs - a.offCommsMs)
    .map((v) => {
      const tag = v.kind === 'prospect' ? '[Prospect]' : '[Member]';
      const name = v.name ? ` \`${v.name}\`` : '';
      return `• <@${v.discordId}>${name} — ${formatDuration(v.offCommsMs)} — ${tag}`;
    });
  return embed.setColor(0xfee75c).setDescription(`${lines.join('\n')}\n\n${updated}`);
}

export function buildProspectAlertEmbed({ userId, alias }, offCommsSince, offCommsMs, serverName) {
  return createEmbed('Prospect')
    .setTitle('Prospect off comms while in-game')
    .setColor(0xed4245)
    .setDescription(`<@${userId}>${alias ? ` (**${alias}**)` : ''} has been playing on **${serverName}** for **${formatDuration(offCommsMs)}** without joining Discord voice.`)
    .addFields(
      { name: 'Since', value: `<t:${Math.floor(offCommsSince / 1000)}:t>`, inline: true },
      { name: 'Duration', value: formatDuration(offCommsMs), inline: true },
    );
}
```

- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(comms-watch): add board and prospect-alert embeds"`.

---

### Task 3: Schema + service

**Files:**
- Modify: `src/database/schema.js` (add table before the final `log.info('Database schema initialized')`).
- Create: `src/services/commsWatch/commsWatchService.js`

**Interfaces:**
- Consumes: `query` (`database/connection.js`), `getDiscordIdBySteamId` (`services/userService.js`), `findEntries` (`services/whitelistService.js`), `getBotState`/`setBotState` (`services/botState.js`).
- Produces: `getOpenProspects()`, `isMember(steamId)`, `getDiscordIdBySteamId` (re-export), `loadAllStates()` (→ `Map<discordId, stateObj>` with ms numbers + bool/null `commsOk`/`observedInVoice`), `upsertState(s)`, `deleteStatesNotIn(discordIds)`, `getBoardPointer()`, `setBoardPointer(channelId, messageId)`, `clearBoardPointer()`.

- [ ] **Step 1: Add table to `schema.js`**:

```js
  // ── Comms watch (in-game players not on Discord voice) ──
  await query(`
    CREATE TABLE IF NOT EXISTS comms_watch_state (
      discord_id          VARCHAR(20) NOT NULL PRIMARY KEY,
      steam_id            VARCHAR(20) NULL,
      name                VARCHAR(100) NULL,
      kind                ENUM('member','prospect') NOT NULL,
      prospect_channel_id VARCHAR(20) NULL,
      prospect_mentor_id  VARCHAR(20) NULL,
      in_game_since       BIGINT NULL,
      observed_in_voice   TINYINT(1) NULL,
      voice_changed_at    BIGINT NULL,
      comms_ok            TINYINT(1) NULL,
      off_comms_since     BIGINT NULL,
      alerted             TINYINT(1) NOT NULL DEFAULT 0,
      updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
```

- [ ] **Step 2: Implement `commsWatchService.js`**:

```js
import { query } from '../../database/connection.js';
import { getDiscordIdBySteamId } from '../userService.js';
import { findEntries } from '../whitelistService.js';
import { getBotState, setBotState } from '../botState.js';
import logger from '../../logger.js';

const log = logger.child({ module: 'commsWatch' });
const BOARD_KEY = 'commsWatchBoard';

const toBool = (x) => (x == null ? null : !!x);
const boolToDb = (x) => (x == null ? null : (x ? 1 : 0));
const num = (x) => (x == null ? null : Number(x));

export { getDiscordIdBySteamId };

export async function getOpenProspects() {
  try {
    return await query(
      `SELECT id, user_id, steam_id, alias, mentor_id, channel_id
       FROM prospects WHERE status = 'open' AND channel_id IS NOT NULL`
    );
  } catch (err) {
    log.warn({ err }, 'Failed to load open prospects');
    return [];
  }
}

export async function isMember(steamId) {
  try {
    const entries = await findEntries(steamId); // active only; [] if website pool absent
    return entries.some((e) => e.role === 'Member');
  } catch {
    return false;
  }
}

export async function loadAllStates() {
  const map = new Map();
  try {
    const rows = await query('SELECT * FROM comms_watch_state');
    for (const r of rows) {
      map.set(r.discord_id, {
        discordId: r.discord_id,
        steamId: r.steam_id,
        name: r.name,
        kind: r.kind,
        prospectChannelId: r.prospect_channel_id,
        prospectMentorId: r.prospect_mentor_id,
        inGameSince: num(r.in_game_since),
        observedInVoice: toBool(r.observed_in_voice),
        voiceChangedAt: num(r.voice_changed_at),
        commsOk: toBool(r.comms_ok),
        offCommsSince: num(r.off_comms_since),
        alerted: !!r.alerted,
      });
    }
  } catch (err) {
    log.warn({ err }, 'Failed to load comms_watch_state');
  }
  return map;
}

export async function upsertState(s) {
  await query(
    `INSERT INTO comms_watch_state
       (discord_id, steam_id, name, kind, prospect_channel_id, prospect_mentor_id,
        in_game_since, observed_in_voice, voice_changed_at, comms_ok, off_comms_since, alerted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       steam_id=VALUES(steam_id), name=VALUES(name), kind=VALUES(kind),
       prospect_channel_id=VALUES(prospect_channel_id), prospect_mentor_id=VALUES(prospect_mentor_id),
       in_game_since=VALUES(in_game_since), observed_in_voice=VALUES(observed_in_voice),
       voice_changed_at=VALUES(voice_changed_at), comms_ok=VALUES(comms_ok),
       off_comms_since=VALUES(off_comms_since), alerted=VALUES(alerted)`,
    [s.discordId, s.steamId ?? null, s.name ?? null, s.kind, s.prospectChannelId ?? null, s.prospectMentorId ?? null,
     s.inGameSince ?? null, boolToDb(s.observedInVoice), s.voiceChangedAt ?? null, boolToDb(s.commsOk), s.offCommsSince ?? null, s.alerted ? 1 : 0]
  );
}

export async function deleteStatesNotIn(discordIds) {
  try {
    if (!discordIds.length) { await query('DELETE FROM comms_watch_state'); return; }
    const placeholders = discordIds.map(() => '?').join(',');
    await query(`DELETE FROM comms_watch_state WHERE discord_id NOT IN (${placeholders})`, discordIds);
  } catch (err) {
    log.warn({ err }, 'Failed to prune comms_watch_state');
  }
}

export async function getBoardPointer() { return getBotState(BOARD_KEY); }
export async function setBoardPointer(channelId, messageId) { return setBotState(BOARD_KEY, { channelId, messageId }); }
export async function clearBoardPointer() { return setBotState(BOARD_KEY, null); }
```

- [ ] **Step 3: Sanity check** — `bun -e "await import('./src/services/commsWatch/commsWatchService.js'); console.log('ok')"` → prints `ok` (module loads, imports resolve). (No DB needed to import.)
- [ ] **Step 4: Commit** — `git commit -m "feat(comms-watch): add state table and service layer"`.

---

### Task 4: Monitor (scheduler tick + board refresh)

> **Correction (verified on the live box):** there is no SquadJS connection named `Main`.
> The Main server is `squadjs_servers.id` **1** (prod `announcer_server_id=1`). Resolve it via
> `getServerStateById(cfg.serverId)` (default `serverId: 1`, `serverLabel: 'Main'`), the same
> mechanism the seeding announcer uses — NOT `getServerStateByName`.

**Files:**
- Create: `src/services/commsWatch/commsWatchMonitor.js`

**Interfaces:**
- Consumes: everything from Tasks 1–3, `getServerStateByName` (`services/seeding/seedingSocket.js`), `createScheduler` (`utils/scheduler.js`), `reportError` (`services/admin/errorAlertService.js`), `config`.
- Produces: `startScheduler(client)`, `stopScheduler()`, `isSchedulerActive()`, `runMonitorTick(client)`, `refreshBoard(client, violators, c, now)`, `buildCurrentBoardEmbed()`.

- [ ] **Step 1: Implement `commsWatchMonitor.js`**:

```js
import config from '../../config.js';
import logger from '../../logger.js';
import { createScheduler } from '../../utils/scheduler.js';
import { getServerStateByName } from '../seeding/seedingSocket.js';
import { reportError } from '../admin/errorAlertService.js';
import { evaluateComms } from './commsWatchState.js';
import {
  getOpenProspects, isMember, getDiscordIdBySteamId,
  loadAllStates, upsertState, deleteStatesNotIn,
  getBoardPointer, clearBoardPointer,
} from './commsWatchService.js';
import { buildBoardEmbed, buildProspectAlertEmbed } from './commsWatchEmbeds.js';

const log = logger.child({ module: 'commsWatchMonitor' });

function cfg() {
  const c = config.commsWatch || {};
  return {
    enabled: c.enabled ?? false,
    serverName: c.serverName || 'Main',
    tickMs: c.tickMs || 60000,
    boardRefreshMs: c.boardRefreshMs || 120000,
    graceMs: c.blipGraceMs ?? 60000,
    thresholdMs: c.prospectThresholdMs ?? 900000,
    afkChannelId: c.afkChannelId || null,
  };
}

let lastBoardEditAt = 0;
let lastMembershipSig = null;
let lastRenderSig = null;

async function getVoiceSet(client, afkOverride) {
  const guild = await client.guilds.fetch(config.guild.id);
  const afkId = afkOverride || guild.afkChannelId || null;
  const set = new Set();
  for (const vs of guild.voiceStates.cache.values()) {
    if (vs.channelId && vs.channelId !== afkId) set.add(vs.id);
  }
  return set;
}

async function classifyRoster(players) {
  const openProspects = await getOpenProspects();
  const prospectBySteam = new Map();
  for (const p of openProspects) if (p.steam_id) prospectBySteam.set(String(p.steam_id), p);

  const tracked = [];
  for (const pl of players) {
    const steamId = pl.steamID ? String(pl.steamID) : null;
    if (!steamId) continue; // Epic-only -> unmatchable
    const name = pl.name || null;
    const prospect = prospectBySteam.get(steamId);
    if (prospect) {
      tracked.push({ discordId: prospect.user_id, steamId, name, kind: 'prospect', prospectChannelId: prospect.channel_id, prospectMentorId: prospect.mentor_id, alias: prospect.alias });
      continue;
    }
    if (await isMember(steamId)) {
      const discordId = await getDiscordIdBySteamId(steamId);
      if (!discordId) continue; // unlinked member -> can't voice-check
      tracked.push({ discordId, steamId, name, kind: 'member', prospectChannelId: null, prospectMentorId: null, alias: null });
    }
  }
  return tracked;
}

export async function runMonitorTick(client) {
  const c = cfg();
  if (!c.enabled) return;

  const state = getServerStateByName(c.serverName);
  if (!state || !state.connected) return; // never act on stale/absent data

  const players = Array.isArray(state.players) ? state.players : [];
  const now = Date.now();

  const tracked = await classifyRoster(players);
  const voiceSet = await getVoiceSet(client, c.afkChannelId);
  const prevStates = await loadAllStates();

  const violators = [];
  const alerts = [];
  const seen = [];

  for (const t of tracked) {
    seen.push(t.discordId);
    const prev = prevStates.get(t.discordId) || {};
    const obs = { inGame: true, inVoice: voiceSet.has(t.discordId) };
    const next = evaluateComms(prev, obs, now, { graceMs: c.graceMs, thresholdMs: c.thresholdMs });

    await upsertState({
      discordId: t.discordId, steamId: t.steamId, name: t.name, kind: t.kind,
      prospectChannelId: t.prospectChannelId, prospectMentorId: t.prospectMentorId,
      inGameSince: next.inGameSince, observedInVoice: next.observedInVoice,
      voiceChangedAt: next.voiceChangedAt, commsOk: next.commsOk,
      offCommsSince: next.offCommsSince, alerted: next.alerted,
    }).catch((err) => log.warn({ err, discordId: t.discordId }, 'upsertState failed'));

    if (next.isOffComms) violators.push({ discordId: t.discordId, name: t.name, kind: t.kind, offCommsMs: next.offCommsMs });
    if (next.shouldAlert && t.kind === 'prospect') alerts.push({ ...t, offCommsSince: next.offCommsSince, offCommsMs: next.offCommsMs });
  }

  await deleteStatesNotIn(seen);

  for (const a of alerts) {
    await postProspectAlert(client, a, c.serverName).catch((err) => log.warn({ err, discordId: a.discordId }, 'postProspectAlert failed'));
  }

  await refreshBoard(client, violators, c, now).catch((err) => log.warn({ err }, 'refreshBoard failed'));
}

async function postProspectAlert(client, a, serverName) {
  const channel = await client.channels.fetch(a.prospectChannelId).catch(() => null);
  if (!channel) { log.warn({ discordId: a.discordId, channelId: a.prospectChannelId }, 'prospect channel not found'); return; }
  const mentorRoleId = config.prospects?.mentorRoleId || null;
  let content; let allowedMentions;
  if (a.prospectMentorId) { content = `<@${a.prospectMentorId}>`; allowedMentions = { users: [a.prospectMentorId] }; }
  else if (mentorRoleId) { content = `<@&${mentorRoleId}>`; allowedMentions = { roles: [mentorRoleId] }; }
  else { content = undefined; allowedMentions = { parse: [] }; }
  const embed = buildProspectAlertEmbed({ userId: a.discordId, alias: a.alias }, a.offCommsSince, a.offCommsMs, serverName);
  await channel.send({ content, embeds: [embed], allowedMentions });
  log.info({ discordId: a.discordId, offCommsMs: a.offCommsMs }, 'Posted prospect comms alert');
}

function boardSignature(violators) {
  return violators.map((v) => `${v.discordId}:${Math.floor(v.offCommsMs / 60000)}`).sort().join('|');
}

export async function refreshBoard(client, violators, c, now) {
  const pointer = await getBoardPointer();
  if (!pointer?.channelId || !pointer?.messageId) return;

  const membershipSig = violators.map((v) => v.discordId).sort().join(',');
  const membershipChanged = membershipSig !== lastMembershipSig;
  const throttleElapsed = now - lastBoardEditAt >= c.boardRefreshMs;
  const sig = boardSignature(violators);
  if (!membershipChanged && (!throttleElapsed || sig === lastRenderSig)) return;

  const channel = await client.channels.fetch(pointer.channelId).catch(() => null);
  if (!channel) return;
  const message = await channel.messages.fetch(pointer.messageId).catch(() => null);
  if (!message) { await clearBoardPointer(); lastMembershipSig = null; return; }

  await message.edit({ embeds: [buildBoardEmbed(violators, c.serverName, now)] });
  lastBoardEditAt = now;
  lastMembershipSig = membershipSig;
  lastRenderSig = sig;
}

export async function buildCurrentBoardEmbed() {
  const c = cfg();
  const now = Date.now();
  const states = await loadAllStates();
  const violators = [];
  for (const s of states.values()) {
    if (s.commsOk === false && s.offCommsSince != null) {
      violators.push({ discordId: s.discordId, name: s.name, kind: s.kind, offCommsMs: now - s.offCommsSince });
    }
  }
  return buildBoardEmbed(violators, c.serverName, now);
}

const scheduler = createScheduler({
  name: 'commsWatch',
  intervalMs: cfg().tickMs,
  tick: async (client) => {
    try { await runMonitorTick(client); }
    catch (err) { log.error({ err }, 'comms watch tick failed'); reportError(err, { source: 'scheduler:commsWatch' }).catch(() => {}); }
  },
});

export function startScheduler(client) {
  const c = cfg();
  if (!c.enabled) { log.info('Comms watch disabled; scheduler not started'); return; }
  log.info({ serverName: c.serverName, tickMs: c.tickMs, thresholdMs: c.thresholdMs }, 'Starting comms watch scheduler');
  scheduler.start(client);
}
export function stopScheduler() { scheduler.stop(); }
export function isSchedulerActive() { return scheduler.isActive(); }
```

- [ ] **Step 2: Sanity check** — `bun -e "await import('./src/services/commsWatch/commsWatchMonitor.js'); console.log('ok')"` → `ok`.
- [ ] **Step 3: Commit** — `git commit -m "feat(comms-watch): add monitor scheduler and board refresh"`.

---

### Task 5: Command, wiring, config, version bump

**Files:**
- Create: `src/commands/comms-board.js`
- Modify: `src/events/ready.js`
- Modify: `settings.production.js`, `settings.staging.js`, `settings.development.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: `requireRole`, `successEmbed`, board-pointer service fns, `runMonitorTick`, `buildCurrentBoardEmbed`, `config`.

- [ ] **Step 1: Implement `src/commands/comms-board.js`**:

```js
import { SlashCommandBuilder } from 'discord.js';
import { requireRole } from '../utils/permissions.js';
import { successEmbed } from '../utils/embed.js';
import { getBoardPointer, setBoardPointer, clearBoardPointer } from '../services/commsWatch/commsWatchService.js';
import { runMonitorTick, buildCurrentBoardEmbed } from '../services/commsWatch/commsWatchMonitor.js';
import config from '../config.js';
import logger from '../logger.js';

const log = logger.child({ module: 'cmd:comms-board' });
const staffRoles = () => config.prospects?.roles || [];

async function deleteBoard(client, pointer) {
  if (!pointer?.channelId || !pointer?.messageId) return;
  const ch = await client.channels.fetch(pointer.channelId).catch(() => null);
  const msg = ch ? await ch.messages.fetch(pointer.messageId).catch(() => null) : null;
  await msg?.delete().catch(() => null);
}

export default {
  data: new SlashCommandBuilder()
    .setName('comms-board')
    .setDescription('Live board of players in-game but not on Discord voice (staff only)')
    .addSubcommand((s) => s.setName('show').setDescription('Post or move the live comms board to this channel'))
    .addSubcommand((s) => s.setName('stop').setDescription('Remove the live comms board')),

  async execute(interaction) {
    if (await requireRole(interaction, staffRoles())) return;
    const sub = interaction.options.getSubcommand();

    if (sub === 'stop') {
      await deleteBoard(interaction.client, await getBoardPointer());
      await clearBoardPointer();
      return interaction.reply({ embeds: [successEmbed('Comms board removed.')], flags: ['Ephemeral'] });
    }

    await interaction.deferReply({ flags: ['Ephemeral'] });
    await deleteBoard(interaction.client, await getBoardPointer()); // single canonical panel
    await runMonitorTick(interaction.client).catch((err) => log.warn({ err }, 'pre-render tick failed'));
    const embed = await buildCurrentBoardEmbed();
    const posted = await interaction.channel.send({ embeds: [embed] });
    await setBoardPointer(interaction.channel.id, posted.id);
    log.info({ channelId: interaction.channel.id, messageId: posted.id }, 'Comms board posted');
    return interaction.editReply({ embeds: [successEmbed('Comms board posted here — it updates every couple of minutes.')] });
  },
};
```

- [ ] **Step 2: Wire into `ready.js`** — add import near the other scheduler imports and a `safeInit` call after `statusUpdater`:

```js
import { startScheduler as startCommsWatchScheduler } from '../services/commsWatch/commsWatchMonitor.js';
```
```js
    await safeInit('commsWatchScheduler', () => startCommsWatchScheduler(client));
```

- [ ] **Step 3: Add `commsWatch` block to each of `settings.production.js`, `settings.staging.js`, `settings.development.js`** (top-level key in the exported object):

```js
  commsWatch: {
    enabled: true,
    serverId: 1,              // squadjs_servers.id (1 = Main ENG, 2 = Battle)
    serverLabel: 'Main',      // friendly name shown in embeds
    tickMs: 60000,
    boardRefreshMs: 120000,   // ~2 min board refresh for duration ticks
    blipGraceMs: 60000,       // tolerate voice blips shorter than this
    prospectThresholdMs: 900000, // 15 min
    afkChannelId: null,       // null => use guild.afkChannelId
  },
```

- [ ] **Step 4: Bump `package.json`** version `2.30.2` → `2.31.0`.
- [ ] **Step 5: Full test + boot import check** — `bun test` (all pass) and `bun -e "await import('./src/commands/comms-board.js'); await import('./src/events/ready.js'); console.log('ok')"` → `ok`.
- [ ] **Step 6: Commit** — `git commit -m "feat(comms-watch): add staff board command, wiring, and config"` then `git commit -m "chore(release): bump bot to 2.31.0 for comms watch"` (or fold the bump in).

---

## Deploy (after implementation)

- Push `main` (deploys staging), then merge `main` → `production` and push (deploys prod), per the repo deploy mapping. Verify via `gh run list`.
- Register the new command per env: `docker exec royal-secretary-bot-staging bun run deploy-commands` and `docker exec royal-secretary-bot-prod bun run deploy-commands`.
- Confirm containers are `Up` after deploy (schema self-applies `comms_watch_state` on boot).
