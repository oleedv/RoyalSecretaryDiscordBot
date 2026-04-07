import crypto from 'node:crypto';
import { query } from '../database/connection.js';
import logger from '../logger.js';

const log = logger.child({ module: 'userService' });

function generateCuid() {
  return 'c' + crypto.randomBytes(12).toString('hex');
}

export async function getStoredSteamId(discordId) {
  try {
    const rows = await query('SELECT steamId FROM User WHERE discordId = ?', [discordId], 'website');
    return rows[0]?.steamId || null;
  } catch (err) {
    log.warn({ err, discordId }, 'Failed to fetch stored Steam ID');
    return null;
  }
}

export async function getDiscordIdBySteamId(steamId) {
  try {
    const rows = await query('SELECT discordId FROM User WHERE steamId = ?', [steamId], 'website');
    return rows[0]?.discordId || null;
  } catch (err) {
    log.warn({ err, steamId }, 'Failed to fetch Discord ID by Steam ID');
    return null;
  }
}

export async function linkSteamId(discordId, steamId, discordName) {
  if (!steamId || steamId.toUpperCase() === 'Q') return;
  try {
    await query(
      `INSERT INTO User (id, discordId, discordName, steamId, updatedAt)
       VALUES (?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE steamId = IF(steamId IS NULL, VALUES(steamId), steamId), updatedAt = NOW()`,
      [generateCuid(), discordId, discordName || discordId, steamId],
      'website'
    );
  } catch (err) {
    log.warn({ err, discordId }, 'Could not link Steam ID to website user');
  }
}
