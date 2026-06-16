// Pure helpers for resolving the canonical squadjs_servers.id to a live socket
// connection. There is intentionally NO fallback to "first connection" — an
// unresolved id returns null so callers surface an explicit "unavailable" state.

export function coerceServerId(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

/**
 * @param {Array<{serverId: number|null, state: object}>} entries
 * @param {number|null} serverId
 * @returns {object|null} the matching connection state, or null
 */
export function pickServerStateById(entries, serverId) {
  const target = coerceServerId(serverId);
  if (target == null) return null;
  const match = entries.find((e) => coerceServerId(e.serverId) === target);
  return match ? match.state : null;
}
