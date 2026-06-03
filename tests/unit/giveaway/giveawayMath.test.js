import { describe, it, expect } from 'bun:test';
import { computeTickets } from '../../../src/services/giveaway/giveawayMath.js';

describe('computeTickets', () => {
  it('uses manual hours when entry is a manual entry', () => {
    const entry = { manualHours: 50, manualSeed: 10, steamId: null };
    const live = null;
    const votes = 0;
    const weights = { hours: 1, seed: 2, vote: 1 };
    expect(computeTickets(entry, live, votes, weights)).toBe(70); // 50 + 2*10
  });

  it('uses live SquadJS hours when entry is a linked entry', () => {
    const entry = { manualHours: null, manualSeed: null, steamId: '7656' };
    const live = { playtimeHours: 200, seedHours: 15 };
    const votes = 3;
    const weights = { hours: 1, seed: 2, vote: 1 };
    expect(computeTickets(entry, live, votes, weights)).toBe(233); // 200 + 30 + 3
  });

  it('floors fractional totals', () => {
    const entry = { manualHours: null, manualSeed: null, steamId: '7656' };
    const live = { playtimeHours: 5.7, seedHours: 1.4 };
    const weights = { hours: 1, seed: 2, vote: 1 };
    expect(computeTickets(entry, live, 0, weights)).toBe(8); // floor(5.7 + 2.8) = 8
  });

  it('returns 0 when entry has no hours and no votes', () => {
    const entry = { manualHours: null, manualSeed: null, steamId: '7656' };
    const live = { playtimeHours: 0, seedHours: 0 };
    const weights = { hours: 1, seed: 2, vote: 1 };
    expect(computeTickets(entry, live, 0, weights)).toBe(0);
  });

  it('respects custom weights', () => {
    const entry = { manualHours: 10, manualSeed: 5, steamId: null };
    const weights = { hours: 2, seed: 3, vote: 5 };
    expect(computeTickets(entry, null, 1, weights)).toBe(40); // 20 + 15 + 5
  });
});
