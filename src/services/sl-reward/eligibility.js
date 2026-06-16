// Pure decision logic for the Squad Leader whitelist reward. No I/O here so it stays
// trivially testable; the cron supplies rolling hours + active WhitelistEntry rows.

/**
 * Split a player's active WhitelistEntry rows into their first SL-clan entry and first
 * non-SL entry (paid/clan/admin/etc).
 */
export function classifyWhitelist(entries, slClanId) {
  let slEntry = null;
  let otherEntry = null;
  for (const e of entries) {
    if (e.clanId === slClanId) {
      if (!slEntry) slEntry = e;
    } else if (!otherEntry) {
      otherEntry = e;
    }
  }
  return { slEntry, otherEntry };
}

/**
 * Decide what the grant cron should do for one player.
 * Returns { action: 'grant' | 'extend' | 'skip', reason, slEntry? }.
 */
export function decideRewardAction({
  rollingHours,
  entries,
  slClanId,
  thresholdHours = 5,
  extendThresholdHours = 24,
  nowMs = Date.now()
}) {
  if (rollingHours < thresholdHours) return { action: 'skip', reason: 'under_threshold' };

  const { slEntry, otherEntry } = classifyWhitelist(entries ?? [], slClanId);
  if (otherEntry) return { action: 'skip', reason: 'has_other_whitelist' };
  if (!slEntry) return { action: 'grant', reason: 'first_grant' };

  // A permanent (NULL-expiry) SL entry is already covered indefinitely -- never extend it.
  if (!slEntry.expiresAt) return { action: 'skip', reason: 'still_active' };

  const remainingMs = new Date(slEntry.expiresAt).getTime() - nowMs;
  if (remainingMs < extendThresholdHours * 3600 * 1000) {
    return { action: 'extend', reason: 'near_expiry', slEntry };
  }
  return { action: 'skip', reason: 'still_active' };
}
