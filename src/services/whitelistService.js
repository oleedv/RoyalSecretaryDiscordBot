import { query, getPool } from '../database/connection.js';
import { generateId } from '../utils/id.js';
import { logWhitelistActivity } from './whitelistAudit.js';
import logger from '../logger.js';

const log = logger.child({ module: 'whitelist' });

const toIso = (d) => (d ? new Date(d).toISOString() : null);

// Resolve a clan tag / admin-group name to its FK id so bot-created entries are linked
// (clanId/groupId) exactly like website-created ones — the panel then shows the full clan
// name + group badge instead of a bare string. Cached: tags/names effectively never change.
// Returns null on miss, so callers degrade gracefully to the string-only entry.
const linkIdCache = new Map();
async function resolveLinkId(kind, key) {
  if (!key) return null;
  const cacheKey = `${kind}:${key}`;
  if (linkIdCache.has(cacheKey)) return linkIdCache.get(cacheKey);
  let id = null;
  try {
    const sql = kind === 'clan'
      ? 'SELECT id FROM Clan WHERE tag = ?'
      : 'SELECT id FROM AdminGroup WHERE name = ?';
    const rows = await query(sql, [key], 'website');
    id = rows[0]?.id ?? null;
  } catch (err) {
    log.warn({ err, kind, key }, 'Failed to resolve clan/group link id');
  }
  if (id) linkIdCache.set(cacheKey, id);
  return id;
}

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
    const [clanId, groupId] = await Promise.all([
      resolveLinkId('clan', clan),
      resolveLinkId('group', role),
    ]);

    // A player can hold only one (steamId, 'main') row — the unique key
    // `WhitelistEntry_steamId_server_key`. If one already exists (commonly a stale/expired
    // entry), update it in place: a blind INSERT throws ER_DUP_ENTRY and the whitelist add
    // silently fails. Match on ALL entries (not just active) so expired rows are caught too.
    const existing = await query(
      'SELECT id FROM WhitelistEntry WHERE steamId = ? AND server = \'main\' LIMIT 1',
      [steamId],
      'website'
    );

    if (existing.length > 0) {
      const entryId = existing[0].id;
      await query(
        'UPDATE WhitelistEntry SET name = ?, clan = ?, clanId = ?, role = ?, groupId = ?, addedBy = ?, expiresAt = ? WHERE id = ?',
        [name, clan, clanId, role, groupId, addedBy, expiresAt, entryId],
        'website'
      );
      await logWhitelistActivity('whitelist.update', entryId, { discordId: addedBy, system: 'bot' }, {
        steamId, server: 'main', name, clan, role, expiresAt: toIso(expiresAt),
      });
      return { id: entryId, steamId, server: 'main', name, clan, role, addedBy, expiresAt };
    }

    const id = generateId();
    await query(
      'INSERT INTO WhitelistEntry (id, steamId, server, name, clan, clanId, role, groupId, addedBy, expiresAt, createdAt) VALUES (?, ?, \'main\', ?, ?, ?, ?, ?, ?, ?, NOW())',
      [id, steamId, name, clan, clanId, role, groupId, addedBy, expiresAt],
      'website'
    );
    await logWhitelistActivity('whitelist.add', id, { discordId: addedBy, system: 'bot' }, {
      steamId, server: 'main', name, clan, role, expiresAt: toIso(expiresAt),
    });
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

export async function expireByRole(steamId, role, actor = null) {
  if (!isConfigured()) return null;
  try {
    const entries = await findEntries(steamId);
    const matching = entries.filter((e) => e.role === role);
    for (const entry of matching) {
      await expireEntry(entry.id);
      await logWhitelistActivity('whitelist.update', entry.id, actor, {
        steamId, role, changes: { expiresAt: { to: 'expired' } },
      });
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
      const seederGroupId = await resolveLinkId('group', 'Seeder');
      await query(
        'UPDATE WhitelistEntry SET role = ?, groupId = ?, name = ?, expiresAt = ?, addedBy = ? WHERE id = ?',
        ['Seeder', seederGroupId, name, expiresAt, 'SeedTracker', seederEntry.id],
        'website'
      );
      await logWhitelistActivity('whitelist.update', seederEntry.id, { system: 'seedTracker' }, {
        steamId, name, role: 'Seeder', source: 'seed-tracker',
        changes: { expiresAt: { to: toIso(expiresAt) } },
      });
      return { id: seederEntry.id, steamId, role: 'Seeder', expiresAt };
    }

    // Create new entry
    const id = generateId();
    const seederGroupId = await resolveLinkId('group', 'Seeder');
    await query(
      "INSERT INTO WhitelistEntry (id, steamId, server, name, role, groupId, addedBy, expiresAt, createdAt) VALUES (?, ?, 'main', ?, 'Seeder', ?, 'SeedTracker', ?, NOW())",
      [id, steamId, name, seederGroupId, expiresAt],
      'website'
    );
    await logWhitelistActivity('whitelist.add', id, { system: 'seedTracker' }, {
      steamId, server: 'main', name, role: 'Seeder', source: 'seed-tracker', expiresAt: toIso(expiresAt),
    });
    return { id, steamId, role: 'Seeder', expiresAt };
  } catch (err) {
    log.warn({ err, steamId }, 'Failed to upsert seeder whitelist entry');
    return null;
  }
}

export async function updateRole(steamId, fromRole, toRole, { clearExpiry = false, actor = null } = {}) {
  if (!isConfigured()) return null;
  try {
    const entries = await findEntries(steamId);
    const matching = entries.filter((e) => e.role === fromRole);
    const toGroupId = await resolveLinkId('group', toRole);
    for (const entry of matching) {
      if (clearExpiry) {
        await query(
          'UPDATE WhitelistEntry SET role = ?, groupId = ?, expiresAt = NULL WHERE id = ?',
          [toRole, toGroupId, entry.id],
          'website'
        );
      } else {
        await query(
          'UPDATE WhitelistEntry SET role = ?, groupId = ? WHERE id = ?',
          [toRole, toGroupId, entry.id],
          'website'
        );
      }
      await logWhitelistActivity('whitelist.update', entry.id, actor, {
        steamId,
        changes: {
          role: { from: fromRole, to: toRole },
          ...(clearExpiry ? { expiresAt: { to: null } } : {}),
        },
      });
    }
    return matching.length;
  } catch (err) {
    log.warn({ err, steamId, fromRole, toRole }, 'Failed to update whitelist role');
    return null;
  }
}

// Squad Leader reward entries are identified by clanId (the SL clan). They also set
// role='Whitelist' (the AdminGroup name that admins.cfg maps players into) and name so
// the entry shows the player's name in the panel/cfg rather than a bare steamId. Grants
// stamp addedBy/reason so they're auditable on the website.
export async function createSlEntry(steamId, userId, name, clanId, addedBy, reason, days) {
  if (!isConfigured()) return null;
  try {
    const id = generateId();
    const groupId = await resolveLinkId('group', 'Whitelist');
    await query(
      `INSERT INTO WhitelistEntry (id, steamId, server, name, clanId, role, groupId, userId, addedBy, reason, expiresAt, createdAt)
       VALUES (?, ?, 'main', ?, ?, 'Whitelist', ?, ?, ?, ?, NOW() + INTERVAL ? DAY, NOW())`,
      [id, steamId, name, clanId, groupId, userId, addedBy, reason, days],
      'website'
    );
    await logWhitelistActivity('whitelist.add', id, { discordId: addedBy, system: 'slReward' }, {
      steamId, server: 'main', name, role: 'Whitelist', clanId, days, reason, source: 'sl-reward',
    });
    return { id, steamId, name, clanId, userId, days };
  } catch (err) {
    log.warn({ err, steamId }, 'Failed to create SL whitelist entry');
    return null;
  }
}

export async function extendEntryByDays(id, days) {
  if (!isConfigured()) return null;
  try {
    await query(
      'UPDATE WhitelistEntry SET expiresAt = expiresAt + INTERVAL ? DAY WHERE id = ?',
      [days, id],
      'website'
    );
    await logWhitelistActivity('whitelist.update', id, { system: 'slReward' }, {
      source: 'sl-reward', changes: { expiresAt: { extendedByDays: days } },
    });
    return true;
  } catch (err) {
    log.warn({ err, id }, 'Failed to extend whitelist entry');
    return null;
  }
}

export async function updateExpiryByRole(steamId, role, expiresAt, actor = null) {
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
      await logWhitelistActivity('whitelist.update', entry.id, actor, {
        steamId, role, changes: { expiresAt: { to: toIso(expiresAt) } },
      });
    }
    return matching.length;
  } catch (err) {
    log.warn({ err, steamId, role }, 'Failed to update whitelist expiry by role');
    return null;
  }
}
