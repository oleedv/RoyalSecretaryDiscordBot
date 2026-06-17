import { query, getPool } from '../database/connection.js';
import { generateId } from '../utils/id.js';
import logger from '../logger.js';

const log = logger.child({ module: 'whitelistAudit' });

// Mirrors the website's AuditLog rows so bot-driven whitelist changes appear in the
// website Activity Log alongside manual changes. Actions/resource match the website's
// whitelist route pattern (resource 'WhitelistEntry', action 'whitelist.*') so they
// surface in the same filters. See webpage packages/api/src/lib/audit.ts.

const SYSTEM_ACTORS = {
  bot: { userId: 'royal-secretary-bot', userName: 'Royal Secretary Bot' },
  seedTracker: { userId: 'seed-tracker', userName: 'Seed Tracker' },
  slReward: { userId: 'sl-reward', userName: 'SL Reward' },
};

function isConfigured() {
  try {
    getPool('website');
    return true;
  } catch {
    return false;
  }
}

// actor: { discordId?, system? }. A known Discord actor is mapped to their website
// User identity (so "filter by user" works); otherwise a system actor is used.
async function resolveActor(actor) {
  if (actor?.discordId) {
    try {
      const rows = await query('SELECT id, discordName FROM User WHERE discordId = ?', [actor.discordId], 'website');
      if (rows[0]) return { userId: rows[0].id, userName: rows[0].discordName };
    } catch (err) {
      log.warn({ err, discordId: actor.discordId }, 'Failed to resolve audit actor from Discord ID');
    }
  }
  return SYSTEM_ACTORS[actor?.system] || SYSTEM_ACTORS.bot;
}

/**
 * Append a whitelist activity row to the website AuditLog. Best-effort: never throws,
 * so it can't break the whitelist write it accompanies.
 */
export async function logWhitelistActivity(action, resourceId, actor, detail) {
  if (!isConfigured()) return;
  try {
    const { userId, userName } = await resolveActor(actor);
    await query(
      `INSERT INTO AuditLog (id, userId, userName, action, resource, resourceId, detail, createdAt)
       VALUES (?, ?, ?, ?, 'WhitelistEntry', ?, ?, NOW())`,
      [generateId(), userId, userName, action, resourceId ?? null, detail ? JSON.stringify(detail) : null],
      'website'
    );
  } catch (err) {
    log.warn({ err, action, resourceId }, 'Failed to write whitelist audit log');
  }
}
