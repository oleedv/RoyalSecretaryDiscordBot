import { query, getPool } from '../database/connection.js';
import { generateId } from '../utils/id.js';
import logger from '../logger.js';

const log = logger.child({ module: 'whitelist' });

export function isConfigured() {
  try {
    getPool('website');
    return true;
  } catch {
    return false;
  }
}

export async function createEntry(steamId, name, clan, role, addedBy, expiresAt = null) {
  if (!isConfigured()) return null;
  try {
    const id = generateId();
    await query(
      'INSERT INTO WhitelistEntry (id, steamId, server, name, clan, role, addedBy, expiresAt, createdAt) VALUES (?, ?, \'main\', ?, ?, ?, ?, ?, NOW())',
      [id, steamId, name, clan, role, addedBy, expiresAt],
      'website'
    );
    return { id, steamId, server: 'main', name, clan, role, addedBy, expiresAt };
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

export async function upsertSeederEntry(steamId, name, expiresAt) {
  if (!isConfigured()) return null;
  try {
    // Check for existing entry
    const existing = await query(
      "SELECT id, role, expiresAt FROM WhitelistEntry WHERE steamId = ? AND server = 'main'",
      [steamId],
      'website'
    );

    if (existing.length > 0) {
      // If they have any active non-Seeder whitelist entry, skip
      const hasActiveNonSeeder = existing.some(e => e.role !== 'Seeder' && (!e.expiresAt || new Date(e.expiresAt) > new Date()));
      if (hasActiveNonSeeder) return null;

      // Find an existing Seeder entry to update, or use the first entry
      const seederEntry = existing.find(e => e.role === 'Seeder') || existing[0];
      await query(
        'UPDATE WhitelistEntry SET role = ?, name = ?, expiresAt = ?, addedBy = ? WHERE id = ?',
        ['Seeder', name, expiresAt, 'SeedTracker', seederEntry.id],
        'website'
      );
      return { id: seederEntry.id, steamId, role: 'Seeder', expiresAt };
    }

    // Create new entry
    const id = generateId();
    await query(
      "INSERT INTO WhitelistEntry (id, steamId, server, name, role, addedBy, expiresAt, createdAt) VALUES (?, ?, 'main', ?, 'Seeder', 'SeedTracker', ?, NOW())",
      [id, steamId, name, expiresAt],
      'website'
    );
    return { id, steamId, role: 'Seeder', expiresAt };
  } catch (err) {
    log.warn({ err, steamId }, 'Failed to upsert seeder whitelist entry');
    return null;
  }
}

export async function updateRole(steamId, fromRole, toRole, { clearExpiry = false } = {}) {
  if (!isConfigured()) return null;
  try {
    const entries = await findEntries(steamId);
    const matching = entries.filter((e) => e.role === fromRole);
    for (const entry of matching) {
      if (clearExpiry) {
        await query(
          'UPDATE WhitelistEntry SET role = ?, expiresAt = NULL WHERE id = ?',
          [toRole, entry.id],
          'website'
        );
      } else {
        await query(
          'UPDATE WhitelistEntry SET role = ? WHERE id = ?',
          [toRole, entry.id],
          'website'
        );
      }
    }
    return matching.length;
  } catch (err) {
    log.warn({ err, steamId, fromRole, toRole }, 'Failed to update whitelist role');
    return null;
  }
}

export async function updateExpiryByRole(steamId, role, expiresAt) {
  if (!isConfigured()) return null;
  try {
    const entries = await findEntries(steamId);
    const matching = entries.filter((e) => e.role === role);
    for (const entry of matching) {
      await query(
        'UPDATE WhitelistEntry SET expiresAt = ? WHERE id = ?',
        [expiresAt, entry.id],
        'website'
      );
    }
    return matching.length;
  } catch (err) {
    log.warn({ err, steamId, role }, 'Failed to update whitelist expiry by role');
    return null;
  }
}
