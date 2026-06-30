import logger from '../../logger.js';
import { createScheduler } from '../../utils/scheduler.js';
import { getTopSeeders, getPlayerSeedStats } from './seedTrackerService.js';
import {
  getSeedingConfig, setLastExpiryCheckDate, setLastLeaderboardMonth,
} from '../seeding/seedingService.js';
import { getAvatarUrl } from '../steamService.js';
import { getDiscordIdBySteamId } from '../userService.js';
import { buildLeaderboardEmbed, buildExpiryWarningEmbed } from './seedTrackerEmbeds.js';
import { shouldRunForPeriod } from './seederRewardLogic.js';
import { query } from '../../database/connection.js';
import { reportError } from '../admin/errorAlertService.js';

const log = logger.child({ module: 'seedTrackerScheduler' });

async function tick(client) {
  const cfg = await getSeedingConfig();
  if (!cfg?.tracker_enabled || cfg.tracker_server_id == null) return;

  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${now.getMonth()}`;
  const currentDate = now.toISOString().slice(0, 10);

  // Run-once-per-period markers are persisted in the DB (seeding_config), not in
  // memory, so a restart does not re-fire these tasks. Set the marker before
  // posting so an at-most-once guarantee holds even if a post throws mid-run.
  if (now.getDate() === 1 && shouldRunForPeriod(cfg.last_leaderboard_month, currentMonth)) {
    await setLastLeaderboardMonth(currentMonth);
    await postLeaderboard(client, cfg);
  }

  const lastExpiryCheckDate = cfg.last_expiry_check_date
    ? new Date(cfg.last_expiry_check_date).toISOString().slice(0, 10)
    : null;
  if (shouldRunForPeriod(lastExpiryCheckDate, currentDate)) {
    await setLastExpiryCheckDate(currentDate);
    await checkExpiringWhitelists(client, cfg);
  }
}

const scheduler = createScheduler({
  name: 'seedTrackerScheduler',
  intervalMs: 3600000,
  tick,
});

export function startScheduler(client) { scheduler.start(client); }
export function stopScheduler() { scheduler.stop(); }

async function postLeaderboard(client, cfg) {
  const channelId = cfg.leaderboard_channel_id;
  if (!channelId) return;

  try {
    const windowDays = cfg.rolling_window_days || 30;
    const seeders = await getTopSeeders(windowDays, 20, cfg.tracker_server_id);
    const embed = buildLeaderboardEmbed(seeders, windowDays);

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel) {
      await channel.send({ embeds: [embed] });
      log.info('Monthly seeder leaderboard posted');
    }
  } catch (err) {
    log.error({ err }, 'Failed to post seeder leaderboard');
    reportError(err, { source: 'scheduler:seedTracker:leaderboard' }).catch(() => {});
  }
}

async function checkExpiringWhitelists(client, cfg) {
  const channelId = cfg.progression_channel_id;
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

    const requiredDays = cfg.required_seed_days || 10;
    const windowDays = cfg.rolling_window_days || 30;

    for (const entry of rows) {
      const stats = await getPlayerSeedStats(entry.steamId, windowDays, cfg.tracker_server_id);
      const seedsNeeded = Math.max(0, requiredDays - stats.uniqueDays);
      const [avatarUrl, discordId] = await Promise.all([
        getAvatarUrl(entry.steamId),
        getDiscordIdBySteamId(entry.steamId),
      ]);
      const embed = buildExpiryWarningEmbed({
        name: entry.name,
        steamId: entry.steamId,
        avatarUrl,
        expiresAt: entry.expiresAt,
        uniqueDays: stats.uniqueDays,
        required: requiredDays,
        seedsNeeded,
        discordId,
      });
      await channel.send({ embeds: [embed] });
    }

    log.info({ count: rows.length }, 'Expiry warnings sent');
  } catch (err) {
    log.warn({ err }, 'Failed to check expiring whitelists');
  }
}
