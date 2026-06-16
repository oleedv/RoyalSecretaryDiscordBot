import config from '../../config.js';

// Per-environment values come from settings.{env}.js (config.slReward); everything has
// a safe default so the feature degrades to "do nothing" if a key is missing.
const sl = config.slReward ?? {};

export const SL_CLAN_ID = sl.clanId ?? 'cmq8eaiat03ym01qtcdgs7bri';
export const SL_SERVER = sl.server ?? 'main';
export const SL_THRESHOLD_HOURS = sl.thresholdHours ?? 5;
export const SL_REWARD_DAYS = sl.rewardDays ?? 7;
export const SL_EXTEND_WHEN_REMAINING_HOURS = sl.extendWhenRemainingHours ?? 24;

export const SL_GRANT_INTERVAL_MS = sl.grantIntervalMs ?? 30 * 60 * 1000;
export const SL_LEADERBOARD_INTERVAL_MS = sl.leaderboardIntervalMs ?? 3 * 60 * 60 * 1000;

export const SL_LEADERBOARD_CHANNEL_ID = sl.leaderboardChannelId ?? null;
export const SL_HYPERCARE_CHANNEL_ID = sl.hypercareChannelId ?? null;
export const SL_HYPERCARE_VERBOSE = sl.hypercareVerbose ?? false;

// When true the grant cron logs intended actions but writes nothing to WhitelistEntry.
export const SL_DRY_RUN = sl.dryRun ?? false;
