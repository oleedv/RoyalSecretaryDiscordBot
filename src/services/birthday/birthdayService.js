import { query } from '../../database/connection.js';
import { isConfigured } from '../whitelistService.js';
import logger from '../../logger.js';

const log = logger.child({ module: 'birthdayService' });

// Re-export so the scheduler can guard on the optional `website` pool (same guard
// the SL grant cron uses — getPool('website') throws when the pool is unconfigured).
export { isConfigured };

// Read the singleton BirthdayConfig row from the webpage DB (royal_battalion) via
// the optional `website` pool. Returns null when unset/unavailable.
export async function getBirthdayConfig() {
  try {
    const rows = await query(
      `SELECT enabled, channelId, postTime, timezone FROM BirthdayConfig WHERE id = 'singleton' LIMIT 1`,
      [],
      'website',
    );
    const r = rows?.[0];
    if (!r) return null;
    return {
      enabled: !!r.enabled,
      channelId: r.channelId ?? null,
      postTime: r.postTime || '09:00',
      timezone: r.timezone || 'Europe/Oslo',
    };
  } catch (err) {
    log.warn({ err }, 'Failed to read BirthdayConfig');
    return null;
  }
}

// Distinct active member-role holders whose birthday matches one of `targets`
// today. `targets` is an array of { month, day } (birthdayLogic.birthdayTargets).
// YEAR/MONTH/DAY are extracted in SQL so matching is timezone-agnostic w.r.t. how
// the driver reconstructs the DATETIME.
export async function getEligibleBirthdayMembers(targets) {
  if (!Array.isArray(targets) || targets.length === 0) return [];
  const targetClause = targets
    .map(() => '(MONTH(u.dateOfBirth) = ? AND DAY(u.dateOfBirth) = ?)')
    .join(' OR ');
  const params = targets.flatMap((t) => [t.month, t.day]);
  try {
    return await query(
      `SELECT DISTINCT u.id AS id, u.discordId AS discordId,
              YEAR(u.dateOfBirth) AS dobYear, MONTH(u.dateOfBirth) AS dobMonth, DAY(u.dateOfBirth) AS dobDay,
              u.avatarUrl AS avatarUrl, u.displayName AS displayName, u.discordName AS discordName,
              u.birthdayShowAge AS birthdayShowAge
       FROM User u
       JOIN UserRole ur ON ur.userId = u.id
       JOIN DiscordRole r ON r.id = ur.roleId AND r.isMemberRole = 1
       WHERE u.disabled = 0
         AND u.birthdayOptOut = 0
         AND u.dateOfBirth IS NOT NULL
         AND NOT (MONTH(u.dateOfBirth) = 1 AND DAY(u.dateOfBirth) = 1)
         AND (${targetClause})`,
      params,
      'website',
    );
  } catch (err) {
    log.error({ err }, 'Eligibility query failed');
    return [];
  }
}

// Discord ids already posted for `postDate` (secretary DB). Returns null on a read
// error so the caller skips the tick rather than risk a double-post.
export async function loadPostedToday(postDate) {
  try {
    const rows = await query(`SELECT user_id FROM birthday_post_log WHERE post_date = ?`, [postDate]);
    return new Set(rows.map((r) => String(r.user_id)));
  } catch (err) {
    log.error({ err, postDate }, 'Failed to load birthday_post_log');
    return null;
  }
}

// Idempotency insert; INSERT IGNORE tolerates a concurrent/duplicate insert.
export async function recordPosted(discordId, postDate) {
  await query(`INSERT IGNORE INTO birthday_post_log (user_id, post_date) VALUES (?, ?)`, [
    String(discordId),
    postDate,
  ]);
}
