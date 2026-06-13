// Pure health check for the SquadJS roster fetch.
// The player COUNT comes from broadcast events, but the ROSTER comes from a
// request-ack (emit('players', cb)). If that ack stops firing, the roster
// freezes silently while the count stays live. `lastPlayersOk` records the
// timestamp of the last successful array ack; if it goes stale while connected,
// the roster is frozen and the connection should be recycled.
export function isRosterStale(state, now, staleMs) {
  if (!state || !state.connected) return false;
  return now - (state.lastPlayersOk || 0) > staleMs;
}
