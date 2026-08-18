import { describe, it, expect } from 'bun:test';
import { configFromRow, DEFAULT_PROSPECT_CONFIG, applyCooldownMessage } from '../prospectConfig.js';

describe('configFromRow', () => {
  it('returns defaults when the row is missing', () => {
    expect(configFromRow(null)).toEqual(DEFAULT_PROSPECT_CONFIG);
    expect(configFromRow(undefined)).toEqual(DEFAULT_PROSPECT_CONFIG);
  });

  it('maps a DB row to camelCase numbers', () => {
    const cfg = configFromRow({
      vote_start_hours: '6',
      vote_accept_hours: '16',
      period_days: '28',
      cooldown_days: '21',
      min_yes_votes: '8',
      min_yes_rate: '0.7500',
    });
    expect(cfg).toEqual({
      voteStartHours: 6,
      voteAcceptHours: 16,
      periodDays: 28,
      cooldownDays: 21,
      minYesVotes: 8,
      minYesRate: 0.75,
    });
  });
});

describe('applyCooldownMessage', () => {
  it('includes a Discord relative timestamp', () => {
    const expires = new Date('2026-09-01T12:00:00.000Z');
    const unix = Math.floor(expires.getTime() / 1000);
    expect(applyCooldownMessage(expires)).toBe(
      `You cannot apply again yet. You can apply <t:${unix}:R>.`
    );
  });
});
