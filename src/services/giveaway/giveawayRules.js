const FALLBACK = {
  windowDays: 30,
  minHours: 5,
  hoursWeight: 1,
  seedWeight: 2,
  voteWeight: 5,
  votesPerVoter: 2,
};

function num(value, fallback) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Resolve per-giveaway ticket rules from the singleton config row,
 * with optional explicit overrides (website start form, slash command).
 */
export function rulesFromConfig(cfg, overrides = {}) {
  return {
    windowDays: overrides.windowDays ?? num(cfg?.window_days, FALLBACK.windowDays),
    minHours: overrides.minHours ?? num(cfg?.min_hours, FALLBACK.minHours),
    hoursWeight: overrides.hoursWeight ?? num(cfg?.hours_weight, FALLBACK.hoursWeight),
    seedWeight: overrides.seedWeight ?? num(cfg?.seed_weight, FALLBACK.seedWeight),
    voteWeight: overrides.voteWeight ?? num(cfg?.vote_weight, FALLBACK.voteWeight),
    votesPerVoter: overrides.votesPerVoter ?? num(cfg?.votes_per_voter, FALLBACK.votesPerVoter),
  };
}

export { FALLBACK as DEFAULT_GIVEAWAY_RULES };
