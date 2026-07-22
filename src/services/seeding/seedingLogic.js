/**
 * Pure decision logic for the seeding announcer monitor (no I/O, fully testable).
 *
 * One automatic BEGUN per day is posted by the daily clock (or staff send-now).
 * The monitor never creates sessions — it only completes or updates an active one.
 * That hard-guarantees no complete → re-seed → complete spam loop.
 *
 * Actions:
 *   complete - population reached the seed threshold; post COMPLETE and close session
 *   update   - active session below threshold; refresh the live call embed
 *   noop     - do nothing (no active session, or unavailable data handled by caller)
 *
 * @param {object} input
 * @param {boolean} input.hasActiveSession
 * @param {number}  input.playerCount
 * @param {number}  input.seedThreshold
 * @returns {{ action: 'complete'|'update'|'noop' }}
 */
export function decideSeedingAction({
  hasActiveSession,
  playerCount,
  seedThreshold,
}) {
  if (!hasActiveSession) return { action: 'noop' };
  if (playerCount >= seedThreshold) return { action: 'complete' };
  return { action: 'update' };
}
