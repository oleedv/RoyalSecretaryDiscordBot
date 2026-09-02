import { describe, it, expect } from 'bun:test';
import { rulesFromConfig } from '../../../src/services/giveaway/giveawayRules.js';

describe('rulesFromConfig', () => {
  it('uses hardcoded fallbacks when config is missing', () => {
    expect(rulesFromConfig(null)).toEqual({
      windowDays: 30,
      minHours: 5,
      hoursWeight: 1,
      seedWeight: 2,
      voteWeight: 5,
      votesPerVoter: 2,
    });
  });

  it('reads values from a config row', () => {
    expect(rulesFromConfig({
      window_days: 14,
      min_hours: '8.50',
      hours_weight: '1.50',
      seed_weight: '3.00',
      vote_weight: 4,
      votes_per_voter: 3,
    })).toEqual({
      windowDays: 14,
      minHours: 8.5,
      hoursWeight: 1.5,
      seedWeight: 3,
      voteWeight: 4,
      votesPerVoter: 3,
    });
  });

  it('lets explicit overrides win over config', () => {
    const cfg = {
      window_days: 14,
      min_hours: 8,
      hours_weight: 1,
      seed_weight: 2,
      vote_weight: 5,
      votes_per_voter: 2,
    };
    expect(rulesFromConfig(cfg, { minHours: 10, voteWeight: 1 })).toEqual({
      windowDays: 14,
      minHours: 10,
      hoursWeight: 1,
      seedWeight: 2,
      voteWeight: 1,
      votesPerVoter: 2,
    });
  });
});
