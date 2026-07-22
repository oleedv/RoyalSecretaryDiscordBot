import { describe, test, expect } from 'bun:test';
import { decideSeedingAction } from '../seedingLogic.js';

const base = {
  seedThreshold: 40,
};

describe('decideSeedingAction - active session', () => {
  test('at or above seed threshold => complete', () => {
    const r = decideSeedingAction({ ...base, hasActiveSession: true, playerCount: 40 });
    expect(r.action).toBe('complete');
  });

  test('above seed threshold => complete', () => {
    const r = decideSeedingAction({ ...base, hasActiveSession: true, playerCount: 80 });
    expect(r.action).toBe('complete');
  });

  test('below seed threshold => update (even if collapsed)', () => {
    const r = decideSeedingAction({ ...base, hasActiveSession: true, playerCount: 5 });
    expect(r.action).toBe('update');
  });

  test('between zero and threshold => update', () => {
    const r = decideSeedingAction({ ...base, hasActiveSession: true, playerCount: 25 });
    expect(r.action).toBe('update');
  });
});

describe('decideSeedingAction - no active session (no re-seed)', () => {
  test('full server after completion => noop (anti-spam)', () => {
    const r = decideSeedingAction({ ...base, hasActiveSession: false, playerCount: 45 });
    expect(r.action).toBe('noop');
  });

  test('collapsed population => noop (no automatic re-seed)', () => {
    const r = decideSeedingAction({ ...base, hasActiveSession: false, playerCount: 10 });
    expect(r.action).toBe('noop');
  });

  test('empty server => noop', () => {
    const r = decideSeedingAction({ ...base, hasActiveSession: false, playerCount: 0 });
    expect(r.action).toBe('noop');
  });

  test('mid population => noop', () => {
    const r = decideSeedingAction({ ...base, hasActiveSession: false, playerCount: 25 });
    expect(r.action).toBe('noop');
  });
});
