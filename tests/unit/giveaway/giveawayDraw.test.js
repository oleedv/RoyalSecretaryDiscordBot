import { describe, it, expect } from 'bun:test';
import { pickWinner } from '../../../src/services/giveaway/giveawayDraw.js';

describe('pickWinner', () => {
  it('returns the only entry when there is one with tickets', () => {
    const entries = [{ userId: '1', tickets: 5 }];
    expect(pickWinner(entries, () => 0.99).userId).toBe('1');
  });

  it('picks first entry when rng rolls 0', () => {
    const entries = [
      { userId: 'a', tickets: 10 },
      { userId: 'b', tickets: 20 },
      { userId: 'c', tickets: 30 },
    ];
    expect(pickWinner(entries, () => 0).userId).toBe('a');
  });

  it('picks last entry when rng rolls near 1', () => {
    const entries = [
      { userId: 'a', tickets: 10 },
      { userId: 'b', tickets: 20 },
      { userId: 'c', tickets: 30 },
    ];
    expect(pickWinner(entries, () => 0.9999).userId).toBe('c');
  });

  it('skips zero-ticket entries', () => {
    const entries = [
      { userId: 'a', tickets: 0 },
      { userId: 'b', tickets: 10 },
    ];
    expect(pickWinner(entries, () => 0).userId).toBe('b');
  });

  it('returns null when total tickets is 0', () => {
    const entries = [
      { userId: 'a', tickets: 0 },
      { userId: 'b', tickets: 0 },
    ];
    expect(pickWinner(entries, () => 0.5)).toBe(null);
  });

  it('returns null when entries is empty', () => {
    expect(pickWinner([], () => 0.5)).toBe(null);
  });

  it('respects ticket weighting across many runs', () => {
    // 'a' has 9x more tickets than 'b' — should win ~90% of the time.
    const entries = [
      { userId: 'a', tickets: 90 },
      { userId: 'b', tickets: 10 },
    ];
    let aWins = 0;
    for (let i = 0; i < 10000; i++) {
      if (pickWinner(entries, Math.random).userId === 'a') aWins++;
    }
    // Allow +/-2% slop. 88%-92% expected.
    expect(aWins).toBeGreaterThan(8800);
    expect(aWins).toBeLessThan(9200);
  });
});
