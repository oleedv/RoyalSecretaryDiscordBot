import { flushActiveSessions } from './voiceTracker.js';
import { query } from '../../database/connection.js';
import { deleteExpiredSuggestions } from '../ai/suggestionRepo.js';
import logger from '../../logger.js';
import { createScheduler } from '../../utils/scheduler.js';

const log = logger.child({ module: 'activityScheduler' });

const FLUSH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_CHECK_MS = 60 * 60 * 1000; // 1 hour
const RETENTION_DAYS = 365;

let cleanupIntervalId = null;
let lastCleanupDate = null;

async function flushTick() {
  await flushActiveSessions();
}

const flushScheduler = createScheduler({
  name: 'activityScheduler',
  intervalMs: FLUSH_INTERVAL_MS,
  tick: flushTick,
});

async function runCleanup() {
  const today = new Date().toISOString().slice(0, 10);
  if (lastCleanupDate === today) return;
  lastCleanupDate = today;

  try {
    const r1 = await query(
      'DELETE FROM voice_sessions WHERE left_at IS NOT NULL AND left_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
      [RETENTION_DAYS]
    );
    const r2 = await query(
      'DELETE FROM message_activity_daily WHERE message_date < DATE_SUB(CURDATE(), INTERVAL ? DAY)',
      [RETENTION_DAYS]
    );
    const r3 = await query(
      'DELETE FROM user_reactions_daily WHERE reaction_date < DATE_SUB(CURDATE(), INTERVAL ? DAY)',
      [RETENTION_DAYS]
    );
    const r4 = await deleteExpiredSuggestions();

    const total = (r1.affectedRows || 0) + (r2.affectedRows || 0) + (r3.affectedRows || 0) + (r4.affectedRows || 0);
    if (total > 0) {
      log.info({
        voice: r1.affectedRows,
        messages: r2.affectedRows,
        reactions: r3.affectedRows,
        suggestions: r4.affectedRows,
      }, `Cleaned up ${total} old activity row(s)`);
    }
  } catch (err) {
    log.error({ err }, 'Activity cleanup failed');
    lastCleanupDate = null; // retry next hour
  }
}

export function startScheduler() {
  flushScheduler.start();
  cleanupIntervalId = setInterval(() => runCleanup(), CLEANUP_CHECK_MS);
}

export function stopScheduler() {
  flushScheduler.stop();
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }
  log.info('Activity scheduler stopped');
}
