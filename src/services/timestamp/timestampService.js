import { query } from '../../database/connection.js';

/**
 * Per-user remembered IANA timezone (Royal_secretary.user_timezone).
 * Set once via /timestamp, reused on every subsequent call.
 */

export async function getUserTimezone(discordId) {
  const rows = await query('SELECT timezone FROM user_timezone WHERE discord_id = ?', [discordId]);
  return rows[0]?.timezone ?? null;
}

export async function setUserTimezone(discordId, timezone) {
  await query(
    'INSERT INTO user_timezone (discord_id, timezone) VALUES (?, ?) ON DUPLICATE KEY UPDATE timezone = VALUES(timezone)',
    [discordId, timezone]
  );
}

export async function clearUserTimezone(discordId) {
  await query('DELETE FROM user_timezone WHERE discord_id = ?', [discordId]);
}
