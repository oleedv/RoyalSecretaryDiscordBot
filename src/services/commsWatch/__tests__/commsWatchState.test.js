import { describe, test, expect } from 'bun:test';
import { evaluateComms, classifyKind, formatDuration } from '../commsWatchState.js';

const OPTS = { graceMs: 60000, thresholdMs: 900000 };
const inGameOff = { inGame: true, inVoice: false };
const inGameOn = { inGame: true, inVoice: true };
const step = (prev, obs, now) => evaluateComms(prev, obs, now, OPTS);

describe('evaluateComms - grace on first sighting', () => {
  test('never in voice: not flagged until grace, then off-comms with growing duration', () => {
    const t0 = step({}, inGameOff, 0);
    expect(t0.isOffComms).toBe(false); // within initial grace
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
    s = step(s, inGameOn, 60000); // stable in voice -> commsOk true
    expect(s.commsOk).toBe(true);
    const drop = step(s, inGameOff, 70000); // 10s drop
    expect(drop.commsOk).toBe(true);
    expect(drop.isOffComms).toBe(false);
    const back = step(drop, inGameOn, 80000);
    expect(back.commsOk).toBe(true);
  });

  test('brief voice join (< grace) during an episode does NOT reset the timer', () => {
    let s = step({}, inGameOff, 0);
    s = step(s, inGameOff, 60000); // off-comms, offCommsSince=0
    expect(s.offCommsSince).toBe(0);
    const join = step(s, inGameOn, 120000); // brief join
    expect(join.isOffComms).toBe(true);
    expect(join.offCommsSince).toBe(0);
    expect(join.offCommsMs).toBe(120000);
  });

  test('sustained rejoin (>= grace) clears the episode and re-arms', () => {
    let s = step({}, inGameOff, 0);
    s = step(s, inGameOff, 60000);
    s = step(s, inGameOn, 120000); // join starts
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

describe('evaluateComms - exempt (prospect while server is on a Seed layer)', () => {
  const exemptOff = { inGame: true, inVoice: false, exempt: true };

  test('exempt short-circuits: never off-comms, never alerts, stays re-armed', () => {
    let s = step({}, exemptOff, 0);
    s = step(s, exemptOff, 60000);
    s = step(s, exemptOff, 900000); // well past threshold, but exempt the whole time
    expect(s.isOffComms).toBe(false);
    expect(s.shouldAlert).toBe(false);
    expect(s.offCommsSince).toBe(null);
    expect(s.alerted).toBe(false);
  });

  test('lifting the exemption starts a FRESH grace+threshold window (no immediate alert)', () => {
    // Off voice through a long seeding period (exempt), then the server goes live.
    let s = step({}, exemptOff, 0);
    s = step(s, exemptOff, 900000); // 15m exempt, still off voice
    // Server switches to a live layer at t=900000 -> exemption lifts here.
    const live0 = step(s, inGameOff, 900000);
    expect(live0.isOffComms).toBe(false); // within the fresh grace
    const live1 = step(live0, inGameOff, 960000); // +60s -> grace elapsed
    expect(live1.isOffComms).toBe(true);
    expect(live1.offCommsSince).toBe(900000); // anchored to the transition, NOT to 0
    expect(live1.shouldAlert).toBe(false); // only 1m of live off-comms
    // Alert fires a full 15m AFTER the server went live, not before.
    const live15 = step(live1, inGameOff, 900000 + 900000);
    expect(live15.shouldAlert).toBe(true);
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
