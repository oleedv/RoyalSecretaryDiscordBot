import { query } from '../database/connection.js';
import logger from '../logger.js';

const log = logger.child({ module: 'userService' });

export async function getStoredSteamId(discordId) {
  try {
    const rows = await query('SELECT steamId FROM User WHERE discordId = ?', [discordId], 'website');
    return rows[0]?.steamId || null;
  } catch (err) {
    log.warn({ err, discordId }, 'Failed to fetch stored Steam ID');
    return null;
  }
}

export async function linkSteamId(discordId, steamId) {
  if (!steamId || steamId.toUpperCase() === 'Q') return;
  try {
    await query(
      'UPDATE User SET steamId = ? WHERE discordId = ? AND (steamId IS NULL OR steamId = ?)',
      [steamId, discordId, steamId],
      'website'
    );
  } catch (err) {
    log.warn({ err, discordId }, 'Could not link Steam ID to website user');
  }
}
