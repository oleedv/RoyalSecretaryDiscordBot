import { query } from '../../database/connection.js';
import logger from '../../logger.js';

const log = logger.child({ module: 'sl-reward-dmqueue' });

// Keep retrying for the life of the reward; drop after this so the table stays small.
const RETENTION_DAYS = 14;

async function deliver(client, discordId, content) {
  try {
    const user = await client.users.fetch(discordId);
    await user.send(content);
    return true;
  } catch (err) {
    log.debug({ err: err?.message, discordId }, 'DM delivery failed');
    return false;
  }
}

async function enqueue(discordId, content) {
  try {
    await query(
      'INSERT INTO sl_pending_dms (discord_id, content, attempts, last_attempt_at) VALUES (?, ?, 1, NOW())',
      [discordId, content]
    );
    log.info({ discordId }, 'DM queued for retry (recipient unreachable)');
  } catch (err) {
    log.warn({ err, discordId }, 'failed to enqueue pending DM');
  }
}

/**
 * Try to DM now; if the recipient is unreachable, queue it for the cron to retry.
 * Returns true if delivered immediately, false if queued.
 */
export async function sendOrQueueDm(client, discordId, content) {
  if (!discordId) return false;
  if (await deliver(client, discordId, content)) return true;
  await enqueue(discordId, content);
  return false;
}

/**
 * Retry queued DMs once. Delivered rows are removed; failures bump the attempt count;
 * rows past the retention window are dropped. Call this periodically (the grant cron does).
 */
export async function flushPendingDms(client) {
  let rows;
  try {
    rows = await query(
      `SELECT id, discord_id, content FROM sl_pending_dms
       WHERE created_at > NOW() - INTERVAL ? DAY
       ORDER BY id LIMIT 100`,
      [RETENTION_DAYS]
    );
  } catch (err) {
    log.warn({ err }, 'failed to load pending DMs');
    return { sent: 0, remaining: 0 };
  }

  let sent = 0;
  for (const r of rows) {
    if (await deliver(client, r.discord_id, r.content)) {
      await query('DELETE FROM sl_pending_dms WHERE id = ?', [r.id]).catch(() => {});
      sent++;
      log.info({ discordId: r.discord_id }, 'queued DM delivered');
    } else {
      await query(
        'UPDATE sl_pending_dms SET attempts = attempts + 1, last_attempt_at = NOW() WHERE id = ?',
        [r.id]
      ).catch(() => {});
    }
  }

  await query('DELETE FROM sl_pending_dms WHERE created_at <= NOW() - INTERVAL ? DAY', [
    RETENTION_DAYS
  ]).catch(() => {});

  return { sent, remaining: rows.length - sent };
}
