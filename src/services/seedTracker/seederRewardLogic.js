const DAY_MS = 86400000;

/**
 * Decide what to do for a player after a completed seed session. Pure — no I/O.
 * @param {object} p
 * @param {number} p.uniqueDays      distinct seed days in the rolling window
 * @param {number} p.requiredDays    threshold to earn/renew
 * @param {number} p.minProgressionDays minimum seed days before a progression embed shows (gates one-time connects)
 * @param {{role: string, expiresAt: (Date|string|null)}|null} p.whitelist
 * @param {number} p.durationDays    grant/renewal length
 * @param {number} p.maxExtensionDays cap measured from now
 * @param {number} p.nowMs           current epoch ms (injected for testability)
 * @returns {{action: 'skip'|'progression'|'grant'|'extend'|'thank', expiresAt?: Date}}
 */
export function decideSeederAction({ uniqueDays, requiredDays, whitelist, durationDays, maxExtensionDays, nowMs, minProgressionDays = 2 }) {
  // Active non-Seeder whitelist (clan, admin, donor, etc.) — thank them for helping seed.
  if (whitelist && whitelist.role !== 'Seeder') return { action: 'thank' };

  const earned = uniqueDays >= requiredDays;

  if (whitelist && whitelist.role === 'Seeder') {
    if (!earned) return { action: 'skip' };
    const maxMs = nowMs + maxExtensionDays * DAY_MS;
    const newMs = nowMs + durationDays * DAY_MS;
    const currentMs = whitelist.expiresAt ? new Date(whitelist.expiresAt).getTime() : null;
    if (currentMs != null && newMs <= currentMs) return { action: 'skip' };
    return { action: 'extend', expiresAt: new Date(Math.min(newMs, maxMs)) };
  }

  if (earned) return { action: 'grant' };
  // Below the minimum, stay silent — avoids spamming the channel on one-time connects.
  return uniqueDays >= minProgressionDays ? { action: 'progression' } : { action: 'skip' };
}

/**
 * Once-per-day gate for the seeder thank-you. Pure equality of YYYY-MM-DD
 * strings (both computed in the same timezone by the caller).
 * @param {string|null} lastThankedDate  last date we thanked this player (YYYY-MM-DD) or null
 * @param {string} today                 today's date (YYYY-MM-DD)
 * @returns {boolean} true if we should thank now
 */
export function shouldThankToday(lastThankedDate, today) {
  return !lastThankedDate || lastThankedDate !== today;
}

/**
 * Generic once-per-period gate for scheduler tasks. The "last run" marker is
 * expected to be PERSISTED (DB), not held in memory, so the task does not
 * re-fire on every bot restart. Pure string equality of period keys (both
 * computed by the caller, e.g. YYYY-MM-DD for daily or YYYY-M for monthly).
 * @param {string|null} lastRunPeriod  period we last ran in, or null/empty
 * @param {string} currentPeriod       current period key
 * @returns {boolean} true if the task should run now
 */
export function shouldRunForPeriod(lastRunPeriod, currentPeriod) {
  return !lastRunPeriod || lastRunPeriod !== currentPeriod;
}
