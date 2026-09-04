import { query } from '../../database/connection.js';
import { upsertSeederEntry, promoteToMember } from '../whitelistService.js';
import { getDiscordIdBySteamId } from '../userService.js';
import {
  buildProgressionEmbed,
  buildMilestoneEmbed,
  buildWhitelistGrantedEmbed,
  buildDmWhitelistNotification,
  buildSeederThanksEmbed,
} from './seedTrackerEmbeds.js';
import logger from '../../logger.js';
import { getSeedingConfig } from '../seeding/seedingService.js';
import { getTodayDate } from '../seeding/seedingScheduler.js';
import { decideSeederAction, shouldThankToday, shouldRunForPeriod } from './seederRewardLogic.js';
import { getAvatarUrl } from '../steamService.js';

const log = logger.child({ module: 'seedTrackerService' });

export async function getPlayerSeedStats(steamId, windowDays = 30, serverId = null) {
  try {
    const rows = await query(
      `SELECT
        COUNT(DISTINCT s.seed_date) AS uniqueDays,
        AVG(s.quality_score) AS avgQuality,
        MAX(s.seed_date) AS lastSeedDate,
        MIN(s.seed_date) AS firstSeedDate,
        COALESCE(SUM(s.duration_seconds), 0) AS totalDuration
      FROM squadjs_seed_sessions s
      JOIN squadjs_players p ON p.id = s.player_id
      WHERE p.steam_id = ? AND s.status = 'completed'
        AND s.server_id = ?
        AND s.seed_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)`,
      [steamId, serverId, windowDays],
      'squadjs'
    );
    const row = rows[0] || {};
    return {
      uniqueDays: Number(row.uniqueDays) || 0,
      avgQuality: row.avgQuality != null ? Number(row.avgQuality) : null,
      lastSeedDate: row.lastSeedDate || null,
      firstSeedDate: row.firstSeedDate || null,
      totalDuration: Number(row.totalDuration) || 0,
    };
  } catch (err) {
    log.warn({ err, steamId }, 'Failed to fetch player seed stats');
    return { uniqueDays: 0, avgQuality: null, lastSeedDate: null, firstSeedDate: null, totalDuration: 0 };
  }
}

export async function getSeedStreak(steamId, serverId = null) {
  try {
    const rows = await query(
      `SELECT DISTINCT s.seed_date AS seedDate
      FROM squadjs_seed_sessions s
      JOIN squadjs_players p ON p.id = s.player_id
      WHERE p.steam_id = ? AND s.status = 'completed'
        AND s.server_id = ?
      ORDER BY s.seed_date DESC
      LIMIT 100`,
      [steamId, serverId],
      'squadjs'
    );

    if (!rows.length) return 0;

    let streak = 1;
    for (let i = 1; i < rows.length; i++) {
      const prev = new Date(rows[i - 1].seedDate);
      const curr = new Date(rows[i].seedDate);
      const diffDays = Math.round((prev.getTime() - curr.getTime()) / 86400000);
      if (diffDays === 1) {
        streak++;
      } else {
        break;
      }
    }

    return streak;
  } catch (err) {
    log.warn({ err, steamId }, 'Failed to compute seed streak');
    return 0;
  }
}

export async function getTotalSeedDays(steamId, serverId = null) {
  try {
    const rows = await query(
      `SELECT COUNT(DISTINCT s.seed_date) AS totalDays
      FROM squadjs_seed_sessions s
      JOIN squadjs_players p ON p.id = s.player_id
      WHERE p.steam_id = ? AND s.status = 'completed'
        AND s.server_id = ?`,
      [steamId, serverId],
      'squadjs'
    );
    return Number(rows[0]?.totalDays) || 0;
  } catch (err) {
    log.warn({ err, steamId }, 'Failed to fetch total seed days');
    return 0;
  }
}

export async function getSeederWhitelist(steamId) {
  try {
    const rows = await query(
      `SELECT id, role, expiresAt FROM WhitelistEntry
      WHERE steamId = ? AND server = 'main'
      AND (expiresAt IS NULL OR expiresAt > NOW())
      LIMIT 1`,
      [steamId],
      'website'
    );
    return rows[0] || null;
  } catch (err) {
    log.warn({ err, steamId }, 'Failed to check seeder whitelist');
    return null;
  }
}

export async function isWebsiteMember(steamId) {
  try {
    const rows = await query(
      `SELECT 1 AS ok
       FROM User u
       JOIN UserRole ur ON ur.userId = u.id
       JOIN DiscordRole r ON r.id = ur.roleId AND r.isMemberRole = 1
       WHERE u.steamId = ? AND u.disabled = 0
       LIMIT 1`,
      [steamId],
      'website'
    );
    return rows.length > 0;
  } catch (err) {
    log.warn({ err, steamId }, 'Failed to check website membership');
    return false;
  }
}

export async function getTopSeeders(windowDays = 30, limit = 20, serverId = null) {
  try {
    const rows = await query(
      `SELECT
        p.name, p.steam_id AS steamId,
        COUNT(DISTINCT s.seed_date) AS seedDays,
        COALESCE(SUM(s.duration_seconds), 0) AS totalDuration,
        AVG(s.quality_score) AS avgQuality
      FROM squadjs_seed_sessions s
      JOIN squadjs_players p ON p.id = s.player_id
      WHERE s.status = 'completed'
        AND s.server_id = ?
        AND s.seed_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY s.player_id
      ORDER BY seedDays DESC, totalDuration DESC
      LIMIT ?`,
      [serverId, windowDays, limit],
      'squadjs'
    );
    return rows.map((r) => ({
      name: r.name,
      steamId: r.steamId,
      seedDays: Number(r.seedDays),
      totalDuration: Number(r.totalDuration),
      avgQuality: r.avgQuality != null ? Number(r.avgQuality) : null,
    }));
  } catch (err) {
    log.warn({ err }, 'Failed to fetch top seeders');
    return [];
  }
}

async function thankWhitelistedSeeder(data, cfg, client) {
  const channelId = cfg.appreciation_channel_id;
  if (!channelId) return;

  const tz = cfg.timezone || 'UTC';
  const today = getTodayDate(tz);
  const lastThanked = await getLastThankedDate(data.steamID);
  if (!shouldThankToday(lastThanked, today)) return;

  const serverId = cfg.tracker_server_id;
  const [avatarUrl, streak, totalDays, discordId] = await Promise.all([
    getAvatarUrl(data.steamID),
    getSeedStreak(data.steamID, serverId),
    getTotalSeedDays(data.steamID, serverId),
    getDiscordIdBySteamId(data.steamID),
  ]);
  const embed = buildSeederThanksEmbed({ name: data.playerName, avatarUrl, streak, totalDays, discordId });
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  // Record the thanks BEFORE posting so a failed/duplicate post can't re-thank next event
  // (mirrors the scheduler's set-marker-before-post at-most-once pattern). Worst case on a
  // post failure is a missed cosmetic thanks that day, not a spam loop.
  await recordThanked(data.steamID, data.playerName, today);
  await channel.send({ embeds: [embed] });
}

export async function processCompletedSession(data, client) {
  try {
    const cfg = await getSeedingConfig();
    if (!cfg?.tracker_enabled) {
      log.debug('seed tracker disabled, skipping');
      return;
    }
    if (cfg.tracker_server_id == null) {
      log.warn('tracker_server_id not configured — seed tracker unavailable, skipping');
      return;
    }
    if (!data?.steamID) {
      log.warn({ player: data?.playerName }, 'Seed session complete event missing steamID, skipping');
      return;
    }

    const requiredDays = cfg.required_seed_days || 10;
    const windowDays = cfg.rolling_window_days || 30;
    const serverId = cfg.tracker_server_id;

    const [stats, whitelist, isMember] = await Promise.all([
      getPlayerSeedStats(data.steamID, windowDays, serverId),
      getSeederWhitelist(data.steamID),
      isWebsiteMember(data.steamID),
    ]);

    const decision = decideSeederAction({
      uniqueDays: stats.uniqueDays,
      requiredDays,
      whitelist,
      isMember,
      durationDays: cfg.whitelist_duration_days || 30,
      maxExtensionDays: cfg.max_extension_days || 60,
      nowMs: Date.now(),
      minProgressionDays: cfg.min_progression_days ?? 2,
    });

    if (decision.action === 'skip') return;

    if (decision.action === 'extend') {
      await upsertSeederEntry(data.steamID, data.playerName, decision.expiresAt);
      log.info({ steamId: data.steamID, newExpiry: decision.expiresAt }, 'Seeder whitelist renewed');
      return;
    }

    if (decision.action === 'grant') {
      await grantSeederWhitelist(data.steamID, data.playerName, client);
      return;
    }

    if (decision.action === 'thank') {
      // Leftover Seeder row on a member (accepted before role-agnostic promote,
      // or given the member role by hand) — convert it once so seed-tracker
      // stops renewing a seeder whitelist they should not have.
      if (isMember && whitelist?.role === 'Seeder') {
        await promoteToMember(data.steamID, data.playerName, { system: 'seedTracker' });
        log.info({ steamId: data.steamID }, 'Promoted leftover Seeder whitelist to Member');
      }
      await thankWhitelistedSeeder(data, cfg, client);
      return;
    }

    // progression
    const channelId = cfg.progression_channel_id;
    if (!channelId) return;

    // At most one progression post per player per day — a player who rejoins
    // several times a day would otherwise spam the channel with near-identical
    // embeds. Record the marker BEFORE posting (at-most-once, like the thank-you
    // gate): worst case on a send failure is a missed cosmetic post, not a loop.
    const today = getTodayDate(cfg.timezone || 'UTC');
    const lastPosted = await getLastPostDate(data.steamID, 'progression');
    if (!shouldRunForPeriod(lastPosted, today)) {
      log.debug({ steamId: data.steamID }, 'Progression already posted today, skipping');
      return;
    }

    const [streak, avatarUrl, discordId] = await Promise.all([
      getSeedStreak(data.steamID, serverId),
      getAvatarUrl(data.steamID),
      getDiscordIdBySteamId(data.steamID),
    ]);
    const seedAgainBy = stats.firstSeedDate
      ? new Date(new Date(stats.firstSeedDate).getTime() + windowDays * 86400000)
      : null;
    const embed = buildProgressionEmbed({
      name: data.playerName,
      steamId: data.steamID,
      uniqueDays: stats.uniqueDays,
      required: requiredDays,
      streak,
      avatarUrl,
      seedAgainBy,
      discordId,
    });
    await recordPost(data.steamID, data.playerName, 'progression', today);
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel) await channel.send({ embeds: [embed] });
  } catch (err) {
    log.error({ err, steamId: data?.steamID }, 'Failed to process completed seed session');
  }
}

export async function grantSeederWhitelist(steamId, name, client) {
  try {
    const cfg = await getSeedingConfig();
    if (!cfg) return;

    const durationDays = cfg.whitelist_duration_days || 30;
    const expiresAt = new Date(Date.now() + durationDays * 86400000);

    const result = await upsertSeederEntry(steamId, name, expiresAt);
    if (!result) {
      log.debug({ steamId }, 'Whitelist upsert returned null (player may have non-Seeder WL)');
      return;
    }

    log.info({ steamId, expiresAt }, 'Seeder whitelist granted');

    // Try to DM the player (best-effort)
    try {
      const discordId = await getDiscordIdBySteamId(steamId);
      if (discordId) {
        const user = await client.users.fetch(discordId).catch(() => null);
        if (user) {
          const dmEmbed = buildDmWhitelistNotification(name, expiresAt, durationDays);
          await user.send({ embeds: [dmEmbed] }).catch(() => {
            log.debug({ discordId }, 'Could not DM user about whitelist grant');
          });
        }
      }
    } catch (err) {
      log.debug({ err, steamId }, 'Failed to DM player about whitelist grant');
    }

    const channelId = cfg.progression_channel_id;
    if (!channelId) return;
    const embed = buildWhitelistGrantedEmbed(name, steamId, expiresAt, durationDays);
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel) await channel.send({ embeds: [embed] });
  } catch (err) {
    log.error({ err, steamId }, 'Failed to grant seeder whitelist');
  }
}

export async function processMilestone(data, client) {
  try {
    const cfg = await getSeedingConfig();
    if (!cfg?.tracker_enabled) return;

    const whitelist = await getSeederWhitelist(data.steamID);
    if (whitelist) {
      log.debug({ steamId: data.steamID }, 'Player already whitelisted, skipping milestone');
      return;
    }

    const channelId = cfg.progression_channel_id;
    if (!channelId) return;

    // At most one milestone post per player per day (see processCompletedSession).
    if (data.steamID) {
      const today = getTodayDate(cfg.timezone || 'UTC');
      const lastPosted = await getLastPostDate(data.steamID, 'milestone');
      if (!shouldRunForPeriod(lastPosted, today)) {
        log.debug({ steamId: data.steamID }, 'Milestone already posted today, skipping');
        return;
      }
      await recordPost(data.steamID, data.playerName, 'milestone', today);
    }

    const embed = buildMilestoneEmbed(data.playerName, data.milestone, data.uniqueDays);
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel) await channel.send({ embeds: [embed] });
  } catch (err) {
    log.error({ err, steamId: data?.steamID }, 'Failed to process seed milestone');
  }
}

export async function getLastThankedDate(steamId) {
  try {
    const rows = await query(
      `SELECT DATE_FORMAT(last_thanked_date, '%Y-%m-%d') AS lastThankedDate
       FROM seed_thanks WHERE steam_id = ? LIMIT 1`,
      [steamId]
    );
    return rows[0]?.lastThankedDate || null;
  } catch (err) {
    log.warn({ err, steamId }, 'Failed to read seed_thanks');
    return null;
  }
}

export async function recordThanked(steamId, name, dateStr) {
  await query(
    `INSERT INTO seed_thanks (steam_id, player_name, last_thanked_date)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE player_name = VALUES(player_name), last_thanked_date = VALUES(last_thanked_date)`,
    [steamId, name, dateStr]
  );
}

export async function getLastPostDate(steamId, postType) {
  try {
    const rows = await query(
      `SELECT DATE_FORMAT(last_posted_date, '%Y-%m-%d') AS lastPostedDate
       FROM seed_post_log WHERE steam_id = ? AND post_type = ? LIMIT 1`,
      [steamId, postType]
    );
    return rows[0]?.lastPostedDate || null;
  } catch (err) {
    log.warn({ err, steamId, postType }, 'Failed to read seed_post_log');
    return null;
  }
}

export async function recordPost(steamId, name, postType, dateStr) {
  await query(
    `INSERT INTO seed_post_log (steam_id, post_type, player_name, last_posted_date)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE player_name = VALUES(player_name), last_posted_date = VALUES(last_posted_date)`,
    [steamId, postType, name, dateStr]
  );
}
