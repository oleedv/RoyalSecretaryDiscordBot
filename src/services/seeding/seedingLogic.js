/**
 * Pure decision logic for the seeding announcer monitor (no I/O, fully testable).
 *
 * Decides what the 60s monitor tick should do given the current server state and
 * config. Kept side-effect-free so the loop-prevention rules can be unit-tested;
 * the scheduler dispatches on the returned action.
 *
 * Actions:
 *   complete - population reached the seed threshold; post COMPLETE and close session
 *   reset    - population collapsed below reset after peaking above it; close session
 *   update   - active session below threshold; refresh the live call embed
 *   reseed   - no active session but the server genuinely collapsed; post a fresh call
 *   noop     - do nothing
 *
 * @param {object} input
 * @param {boolean} input.hasActiveSession
 * @param {number}  input.playerCount
 * @param {number}  input.peakPlayers            session peak (only meaningful when active)
 * @param {number}  input.seedThreshold
 * @param {number}  input.resetThreshold
 * @param {boolean} input.callPostedToday        last_daily_call_date === today
 * @param {boolean} input.pastDailyTime          currentTime >= dailyTime
 * @param {boolean} input.inResetWindow
 * @param {number}  input.minutesSinceLastCall   now - MAX(started_at); Infinity if none
 * @param {number}  input.reseedCooldownMinutes
 * @returns {{ action: 'complete'|'reset'|'update'|'reseed'|'noop' }}
 */
export function decideSeedingAction({
  hasActiveSession,
  playerCount,
  peakPlayers,
  seedThreshold,
  resetThreshold,
  callPostedToday,
  pastDailyTime,
  inResetWindow,
  minutesSinceLastCall,
  reseedCooldownMinutes,
}) {
  if (hasActiveSession) {
    if (playerCount >= seedThreshold) return { action: 'complete' };
    if (playerCount < resetThreshold && peakPlayers >= resetThreshold) return { action: 'reset' };
    return { action: 'update' };
  }

  // No active session: re-seed only on a genuine collapse (players present but below the
  // reset line) and no sooner than the cooldown since the last call. This is the fix for
  // the complete -> re-seed -> complete spam loop: a seeded/healthy server can't re-arm.
  const collapsed = playerCount > 0 && playerCount < resetThreshold;
  const cooldownElapsed = minutesSinceLastCall >= reseedCooldownMinutes;
  if (callPostedToday && pastDailyTime && !inResetWindow && collapsed && cooldownElapsed) {
    return { action: 'reseed' };
  }

  return { action: 'noop' };
}
