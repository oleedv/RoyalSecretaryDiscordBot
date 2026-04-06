import config from '../../config.js';
import logger from '../../logger.js';
import { getTopSeeders, getPlayerSeedStats } from './seedTrackerService.js';
import { buildLeaderboardEmbed, buildExpiryWarningEmbed } from './seedTrackerEmbeds.js';
import { query } from '../../database/connection.js';

const log = logger.child({ module: 'seedTrackerScheduler' });

let intervalId = null;
let lastLeaderboardMonth = null;
let lastExpiryCheckDate = null;

export function startScheduler(client) {
  if (intervalId) return;
  // Check every hour for leaderboard/expiry
  intervalId = setInterval(() => tick(client), 3600000);
  log.info('Seed tracker scheduler started');
}

export function stopScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('Seed tracker scheduler stopped');
  }
}

async function tick(client) {
  try {
    const seedTracker = config.seedTracker;
    if (!seedTracker) return;

    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${now.getMonth()}`;
    const currentDate = now.toISOString().slice(0, 10);

    // Monthly leaderboard: post on the 1st of each month
    if (now.getDate() === 1 && lastLeaderboardMonth !== currentMonth) {
      lastLeaderboardMonth = currentMonth;
      await postLeaderboard(client, seedTracker);
    }

    // Daily expiry check
    if (lastExpiryCheckDate !== currentDate) {
      lastExpiryCheckDate = currentDate;
      await checkExpiringWhitelists(client, seedTracker);
    }
  } catch (err) {
    log.error({ err }, 'Seed tracker scheduler tick failed');
  }
}

async function postLeaderboard(client, seedTracker) {
  const channelId = seedTracker.leaderboardChannelId;
  if (!channelId) return;

  try {
    const windowDays = seedTracker.rollingWindowDays || 30;
    const seeders = await getTopSeeders(windowDays);
    const embed = buildLeaderboardEmbed(seeders, windowDays);

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel) {
      await channel.send({ embeds: [embed] });
      log.info('Monthly seeder leaderboard posted');
    }
  } catch (err) {
    log.error({ err }, 'Failed to post seeder leaderboard');
  }
}

async function checkExpiringWhitelists(client, seedTracker) {
  const channelId = seedTracker.progressionChannelId;
  if (!channelId) return;

  try {
    const rows = await query(
      `SELECT id, steamId, name, expiresAt FROM WhitelistEntry
      WHERE role = 'Seeder' AND server = 'main'
      AND expiresAt IS NOT NULL
      AND expiresAt > NOW()
      AND expiresAt <= DATE_ADD(NOW(), INTERVAL 7 DAY)`,
      [],
      'website'
    );

    if (!rows.length) return;

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;

    const requiredDays = seedTracker.requiredSeedDays || 10;
    const windowDays = seedTracker.rollingWindowDays || 30;

    for (const entry of rows) {
      const daysRemaining = Math.ceil((new Date(entry.expiresAt).getTime() - Date.now()) / 86400000);
      const stats = await getPlayerSeedStats(entry.steamId, windowDays);
      const seedsNeeded = Math.max(0, requiredDays - stats.uniqueDays);
      const embed = buildExpiryWarningEmbed(entry.name, daysRemaining, seedsNeeded);
      await channel.send({ embeds: [embed] });
    }

    log.info({ count: rows.length }, 'Expiry warnings sent');
  } catch (err) {
    log.warn({ err }, 'Failed to check expiring whitelists');
  }
}
