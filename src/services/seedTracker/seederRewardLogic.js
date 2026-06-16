const DAY_MS = 86400000;

/**
 * Decide what to do for a player after a completed seed session. Pure — no I/O.
 * @param {object} p
 * @param {number} p.uniqueDays      distinct seed days in the rolling window
 * @param {number} p.requiredDays    threshold to earn/renew
 * @param {{role: string, expiresAt: (Date|string|null)}|null} p.whitelist
 * @param {number} p.durationDays    grant/renewal length
 * @param {number} p.maxExtensionDays cap measured from now
 * @param {number} p.nowMs           current epoch ms (injected for testability)
 * @returns {{action: 'skip'|'progression'|'grant'|'extend', expiresAt?: Date}}
 */
export function decideSeederAction({ uniqueDays, requiredDays, whitelist, durationDays, maxExtensionDays, nowMs }) {
  // Any active non-Seeder whitelist (clan, admin, etc.) takes precedence — never touch it.
  if (whitelist && whitelist.role !== 'Seeder') return { action: 'skip' };

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
  return { action: 'progression' };
}
