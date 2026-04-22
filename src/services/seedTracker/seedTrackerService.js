import { query } from '../../database/connection.js';
import { upsertSeederEntry } from '../whitelistService.js';
import { getDiscordIdBySteamId } from '../userService.js';
import {
  buildProgressionEmbed,
  buildMilestoneEmbed,
  buildWhitelistGrantedEmbed,
  buildDmWhitelistNotification,
} from './seedTrackerEmbeds.js';
import config from '../../config.js';
import logger from '../../logger.js';

const log = logger.child({ module: 'seedTrackerService' });

export async function getPlayerSeedStats(steamId, windowDays = 30) {
  try {
    const rows = await query(
      `SELECT
        COUNT(DISTINCT s.seed_date) AS uniqueDays,
        AVG(s.quality_score) AS avgQuality,
        MAX(s.seed_date) AS lastSeedDate,
        COALESCE(SUM(s.duration_seconds), 0) AS totalDuration
      FROM squadjs_seed_sessions s
      JOIN squadjs_players p ON p.id = s.player_id
      WHERE p.steam_id = ? AND s.status = 'completed'
        AND s.seed_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)`,
      [steamId, windowDays],
      'squadjs'
    );
    const row = rows[0] || {};
    return {
      uniqueDays: Number(row.uniqueDays) || 0,
      avgQuality: row.avgQuality != null ? Number(row.avgQuality) : null,
      lastSeedDate: row.lastSeedDate || null,
      totalDuration: Number(row.totalDuration) || 0,
    };
  } catch (err) {
    log.warn({ err, steamId }, 'Failed to fetch player seed stats');
    return { uniqueDays: 0, avgQuality: null, lastSeedDate: null, totalDuration: 0 };
  }
}

export async function getSeedStreak(steamId) {
  try {
    const rows = await query(
      `SELECT DISTINCT s.seed_date AS seedDate
      FROM squadjs_seed_sessions s
      JOIN squadjs_players p ON p.id = s.player_id
      WHERE p.steam_id = ? AND s.status = 'completed'
      ORDER BY s.seed_date DESC
      LIMIT 100`,
      [steamId],
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

export async function getTopSeeders(windowDays = 30, limit = 20) {
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
        AND s.seed_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY s.player_id
      ORDER BY seedDays DESC, totalDuration DESC
      LIMIT ?`,
      [windowDays, limit],
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

export async function processCompletedSession(data, client) {
  try {
    const seedTracker = config.seedTracker;
    if (!seedTracker) {
      log.debug('seedTracker config not set, skipping');
      return;
    }

    if (!data?.steamID) {
      log.warn({ player: data?.playerName }, 'Seed session complete event missing steamID, skipping');
      return;
    }

    const requiredDays = seedTracker.requiredSeedDays || 10;
    const [stats, whitelist] = await Promise.all([
      getPlayerSeedStats(data.steamID, seedTracker.rollingWindowDays || 30),
      getSeederWhitelist(data.steamID),
    ]);

    // If player has a non-Seeder whitelist (clan, admin, etc.), skip entirely
    if (whitelist && whitelist.role !== 'Seeder') {
      log.debug({ steamId: data.steamID, role: whitelist.role }, 'Player has non-Seeder whitelist, skipping');
      return;
    }

    // If player has a Seeder whitelist, check if they qualify for renewal/extension
    if (whitelist && whitelist.role === 'Seeder') {
      if (stats.uniqueDays >= requiredDays) {
        const maxExtension = seedTracker.maxExtensionDays || 60;
        const maxDate = new Date(Date.now() + maxExtension * 86400000);
        const currentExpiry = whitelist.expiresAt ? new Date(whitelist.expiresAt) : null;
        const newExpiry = new Date(Date.now() + (seedTracker.whitelistDurationDays || 30) * 86400000);

        // Only extend if not already at max
        if (!currentExpiry || newExpiry > currentExpiry) {
          const cappedExpiry = newExpiry > maxDate ? maxDate : newExpiry;
          await upsertSeederEntry(data.steamID, data.playerName, cappedExpiry);
          log.info({ steamId: data.steamID, newExpiry: cappedExpiry }, 'Seeder whitelist renewed');
        }
      }
      // Don't post progression for already-whitelisted seeders
      return;
    }

    // Player is NOT whitelisted - check if they've earned one
    if (stats.uniqueDays >= requiredDays) {
      await grantSeederWhitelist(data.steamID, data.playerName, client);
      return;
    }

    // Post progression embed for non-whitelisted players
    const channelId = seedTracker.progressionChannelId;
    if (!channelId) return;

    const streak = await getSeedStreak(data.steamID);
    const embed = buildProgressionEmbed(
      data.playerName, data.steamID, stats.uniqueDays, requiredDays, streak, stats.avgQuality
    );

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel) {
      await channel.send({ embeds: [embed] });
    }
  } catch (err) {
    log.error({ err, steamId: data.steamID }, 'Failed to process completed seed session');
  }
}

export async function grantSeederWhitelist(steamId, name, client) {
  try {
    const seedTracker = config.seedTracker;
    if (!seedTracker) return;

    const durationDays = seedTracker.whitelistDurationDays || 30;
    const expiresAt = new Date(Date.now() + durationDays * 86400000);

    const result = await upsertSeederEntry(steamId, name, expiresAt);
    if (!result) {
      log.debug({ steamId }, 'Whitelist upsert returned null (player may have non-Seeder WL)');
      return;
    }

    log.info({ steamId, expiresAt }, 'Seeder whitelist granted');

    // Try to DM the player
    try {
      const discordId = await getDiscordIdBySteamId(steamId);
      if (discordId) {
        const user = await client.users.fetch(discordId).catch(() => null);
        if (user) {
          const dmEmbed = buildDmWhitelistNotification(name, expiresAt);
          await user.send({ embeds: [dmEmbed] }).catch(() => {
            log.debug({ discordId }, 'Could not DM user about whitelist grant');
          });
        }
      }
    } catch (err) {
      log.debug({ err, steamId }, 'Failed to DM player about whitelist grant');
    }

    // Post celebration embed to progression channel
    const channelId = seedTracker.progressionChannelId;
    if (!channelId) return;

    const embed = buildWhitelistGrantedEmbed(name, steamId, expiresAt);
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel) {
      await channel.send({ embeds: [embed] });
    }
  } catch (err) {
    log.error({ err, steamId }, 'Failed to grant seeder whitelist');
  }
}

export async function processMilestone(data, client) {
  try {
    const seedTracker = config.seedTracker;
    if (!seedTracker) return;

    const whitelist = await getSeederWhitelist(data.steamID);
    if (whitelist) {
      log.debug({ steamId: data.steamID }, 'Player already whitelisted, skipping milestone');
      return;
    }

    const channelId = seedTracker.progressionChannelId;
    if (!channelId) return;

    const embed = buildMilestoneEmbed(data.playerName, data.milestone, data.uniqueDays);
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel) {
      await channel.send({ embeds: [embed] });
    }
  } catch (err) {
    log.error({ err, steamId: data.steamID }, 'Failed to process seed milestone');
  }
}
