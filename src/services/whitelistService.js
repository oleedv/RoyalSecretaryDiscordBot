import crypto from 'node:crypto';
import { query, getPool } from '../database/connection.js';
import logger from '../logger.js';

const log = logger.child({ module: 'whitelist' });

function generateId() {
  return 'c' + crypto.randomBytes(12).toString('hex');
}

export function isConfigured() {
  try {
    getPool('website');
    return true;
  } catch {
    return false;
  }
}

export async function createEntry(steamId, name, clan, role, addedBy) {
  if (!isConfigured()) return null;
  try {
    const id = generateId();
    await query(
      'INSERT INTO WhitelistEntry (id, steamId, server, name, clan, role, addedBy, createdAt) VALUES (?, ?, \'main\', ?, ?, ?, ?, NOW())',
      [id, steamId, name, clan, role, addedBy],
      'website'
    );
    return { id, steamId, server: 'main', name, clan, role, addedBy };
  } catch (err) {
    log.warn({ err, steamId }, 'Failed to create whitelist entry');
    return null;
  }
}

export async function findEntries(steamId) {
  if (!isConfigured()) return [];
  try {
    return await query(
      'SELECT * FROM WhitelistEntry WHERE steamId = ? AND server = \'main\' AND (expiresAt IS NULL OR expiresAt > NOW())',
      [steamId],
      'website'
    );
  } catch (err) {
    log.warn({ err, steamId }, 'Failed to find whitelist entries');
    return [];
  }
}

export async function expireEntry(id) {
  if (!isConfigured()) return null;
  try {
    await query('UPDATE WhitelistEntry SET expiresAt = NOW() WHERE id = ?', [id], 'website');
    return true;
  } catch (err) {
    log.warn({ err, id }, 'Failed to expire whitelist entry');
    return null;
  }
}

export async function expireByRole(steamId, role) {
  if (!isConfigured()) return null;
  try {
    const entries = await findEntries(steamId);
    const matching = entries.filter((e) => e.role === role);
    for (const entry of matching) {
      await expireEntry(entry.id);
    }
    return matching.length;
  } catch (err) {
    log.warn({ err, steamId, role }, 'Failed to expire whitelist entries by role');
    return null;
  }
}

export async function updateRole(steamId, fromRole, toRole) {
  if (!isConfigured()) return null;
  try {
    const entries = await findEntries(steamId);
    const matching = entries.filter((e) => e.role === fromRole);
    for (const entry of matching) {
      await query(
        'UPDATE WhitelistEntry SET role = ? WHERE id = ?',
        [toRole, entry.id],
        'website'
      );
    }
    return matching.length;
  } catch (err) {
    log.warn({ err, steamId, fromRole, toRole }, 'Failed to update whitelist role');
    return null;
  }
}
