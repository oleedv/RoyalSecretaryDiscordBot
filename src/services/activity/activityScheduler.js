import { flushActiveSessions } from './voiceTracker.js';
import { query } from '../../database/connection.js';
import logger from '../../logger.js';

const log = logger.child({ module: 'activityScheduler' });

const FLUSH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_CHECK_MS = 60 * 60 * 1000; // 1 hour
const RETENTION_DAYS = 365;

let flushIntervalId = null;
let cleanupIntervalId = null;
let lastCleanupDate = null;

export function startScheduler() {
  if (flushIntervalId) {
    log.warn('Activity scheduler already running');
    return;
  }

  log.info('Starting activity scheduler (5m flush, daily cleanup)');

  flushIntervalId = setInterval(() => {
    flushActiveSessions().catch((err) => {
      log.error({ err }, 'Periodic voice session flush failed');
    });
  }, FLUSH_INTERVAL_MS);

  cleanupIntervalId = setInterval(() => runCleanup(), CLEANUP_CHECK_MS);
}

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

    const total = (r1.affectedRows || 0) + (r2.affectedRows || 0) + (r3.affectedRows || 0);
    if (total > 0) {
      log.info({ voice: r1.affectedRows, messages: r2.affectedRows, reactions: r3.affectedRows }, `Cleaned up ${total} old activity row(s)`);
    }
  } catch (err) {
    log.error({ err }, 'Activity cleanup failed');
    lastCleanupDate = null; // retry next hour
  }
}

export function stopScheduler() {
  if (flushIntervalId) {
    clearInterval(flushIntervalId);
    flushIntervalId = null;
  }
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }
  log.info('Activity scheduler stopped');
}
