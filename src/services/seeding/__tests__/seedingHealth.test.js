import { describe, it, expect } from 'bun:test';
import { isRosterStale } from '../seedingHealth.js';

describe('isRosterStale', () => {
  it('is false when disconnected', () => {
    expect(isRosterStale({ connected: false, lastPlayersOk: 0 }, 1_000_000, 120_000)).toBe(false);
  });
  it('is false when a recent successful ack exists', () => {
    const now = 1_000_000;
    expect(isRosterStale({ connected: true, lastPlayersOk: now - 30_000 }, now, 120_000)).toBe(false);
  });
  it('is true when connected but the ack is overdue', () => {
    const now = 1_000_000;
    expect(isRosterStale({ connected: true, lastPlayersOk: now - 200_000 }, now, 120_000)).toBe(true);
  });
  it('treats a missing lastPlayersOk as stale when connected', () => {
    expect(isRosterStale({ connected: true }, 1_000_000, 120_000)).toBe(true);
  });
});
