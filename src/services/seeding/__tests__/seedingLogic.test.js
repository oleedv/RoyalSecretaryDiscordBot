import { describe, test, expect } from 'bun:test';
import { decideSeedingAction } from '../seedingLogic.js';

// Shared config: server seeds at 40, "collapsed" below 20, 60-min re-seed cooldown.
const base = {
  seedThreshold: 40,
  resetThreshold: 20,
  reseedCooldownMinutes: 60,
  callPostedToday: true,
  pastDailyTime: true,
  inResetWindow: false,
};

describe('decideSeedingAction - active session', () => {
  test('at or above seed threshold => complete', () => {
    const r = decideSeedingAction({ ...base, hasActiveSession: true, playerCount: 40, peakPlayers: 40 });
    expect(r.action).toBe('complete');
  });

  test('dropped below reset threshold after peaking above it => reset', () => {
    const r = decideSeedingAction({ ...base, hasActiveSession: true, playerCount: 15, peakPlayers: 30 });
    expect(r.action).toBe('reset');
  });

  test('below reset but never peaked above reset => update (not reset)', () => {
    const r = decideSeedingAction({ ...base, hasActiveSession: true, playerCount: 12, peakPlayers: 12 });
    expect(r.action).toBe('update');
  });

  test('between reset and seed threshold => update', () => {
    const r = decideSeedingAction({ ...base, hasActiveSession: true, playerCount: 25, peakPlayers: 25 });
    expect(r.action).toBe('update');
  });
});

describe('decideSeedingAction - no active session (re-seed guard)', () => {
  // The regression: a fully seeded server must NOT re-seed after completion.
  test('full server after completion => noop (no re-seed loop)', () => {
    const r = decideSeedingAction({ ...base, hasActiveSession: false, playerCount: 45, minutesSinceLastCall: 600 });
    expect(r.action).toBe('noop');
  });

  test('genuine collapse (0 < pop < reset) with cooldown elapsed => reseed', () => {
    const r = decideSeedingAction({ ...base, hasActiveSession: false, playerCount: 10, minutesSinceLastCall: 90 });
    expect(r.action).toBe('reseed');
  });

  test('collapse but cooldown NOT elapsed => noop (backstop)', () => {
    const r = decideSeedingAction({ ...base, hasActiveSession: false, playerCount: 10, minutesSinceLastCall: 30 });
    expect(r.action).toBe('noop');
  });

  test('no prior sessions (Infinity since last call) => reseed allowed', () => {
    const r = decideSeedingAction({ ...base, hasActiveSession: false, playerCount: 10, minutesSinceLastCall: Infinity });
    expect(r.action).toBe('reseed');
  });

  test('dead/empty server (pop 0) => noop', () => {
    const r = decideSeedingAction({ ...base, hasActiveSession: false, playerCount: 0, minutesSinceLastCall: 600 });
    expect(r.action).toBe('noop');
  });

  test('healthy population (reset <= pop < seed) => noop (does not need rallying)', () => {
    const r = decideSeedingAction({ ...base, hasActiveSession: false, playerCount: 25, minutesSinceLastCall: 600 });
    expect(r.action).toBe('noop');
  });

  test('in reset window => noop even if collapsed', () => {
    const r = decideSeedingAction({ ...base, inResetWindow: true, hasActiveSession: false, playerCount: 10, minutesSinceLastCall: 600 });
    expect(r.action).toBe('noop');
  });

  test('daily call not yet posted today => noop', () => {
    const r = decideSeedingAction({ ...base, callPostedToday: false, hasActiveSession: false, playerCount: 10, minutesSinceLastCall: 600 });
    expect(r.action).toBe('noop');
  });

  test('before daily time => noop', () => {
    const r = decideSeedingAction({ ...base, pastDailyTime: false, hasActiveSession: false, playerCount: 10, minutesSinceLastCall: 600 });
    expect(r.action).toBe('noop');
  });
});
