import { query } from '../database/connection.js';
import logger from '../logger.js';

const log = logger.child({ module: 'botState' });

// Small JSON key/value store backed by the `bot_state` table (secretary pool).
export async function getBotState(key) {
  try {
    const rows = await query('SELECT `value` FROM bot_state WHERE `key` = ?', [key]);
    if (!rows || rows.length === 0) return null;
    try {
      return JSON.parse(rows[0].value);
    } catch {
      return rows[0].value;
    }
  } catch (err) {
    log.warn({ err, key }, 'getBotState failed');
    return null;
  }
}

export async function setBotState(key, value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  try {
    await query(
      'INSERT INTO bot_state (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
      [key, serialized]
    );
    return true;
  } catch (err) {
    log.warn({ err, key }, 'setBotState failed');
    return null;
  }
}
