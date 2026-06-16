import { query } from '../../database/connection.js';
import logger from '../../logger.js';
import { createScheduler } from '../../utils/scheduler.js';
import { getBotState, setBotState } from '../botState.js';
import { buildLeaderboardEmbed, buildLeaderboardRows } from './leaderboard.js';
import {
  SL_CLAN_ID,
  SL_LEADERBOARD_CHANNEL_ID,
  SL_LEADERBOARD_INTERVAL_MS,
  SL_SERVER
} from './constants.js';

const log = logger.child({ module: 'sl-reward-leaderboard' });
const STATE_KEY = 'sl_leaderboard_message';

async function tick(client) {
  if (!SL_LEADERBOARD_CHANNEL_ID) {
    log.warn('slReward.leaderboardChannelId not set; skipping leaderboard');
    return;
  }

  const topRows = await query(
    `SELECT p.steam_id AS steam_id, p.name AS in_game_name,
            SUM(s.qualifying_sl_s) / 3600.0 AS hours
     FROM squadjs_sl_round_stats s
     JOIN squadjs_players p ON p.id = s.player_id
     WHERE s.created_at > NOW() - INTERVAL 7 DAY
     GROUP BY p.id
     HAVING SUM(s.qualifying_sl_s) > 0
     ORDER BY hours DESC
     LIMIT 20`,
    [],
    'squadjs'
  ).catch((err) => {
    log.error({ err }, 'leaderboard query failed');
    return [];
  });

  const steamIds = topRows.map((r) => r.steam_id).filter(Boolean);
  let users = [];
  let whitelist = [];
  if (steamIds.length > 0) {
    const ph = steamIds.map(() => '?').join(',');
    users = await query(
      `SELECT steamId, discordName FROM User WHERE steamId IN (${ph})`,
      steamIds,
      'website'
    ).catch(() => []);
    whitelist = await query(
      `SELECT steamId, clanId FROM WhitelistEntry
       WHERE steamId IN (${ph}) AND server = ? AND (expiresAt IS NULL OR expiresAt > NOW())`,
      [...steamIds, SL_SERVER],
      'website'
    ).catch(() => []);
  }

  const rows = buildLeaderboardRows({ topRows, users, whitelist, slClanId: SL_CLAN_ID });
  const nextUpdateUnix = Math.floor((Date.now() + SL_LEADERBOARD_INTERVAL_MS) / 1000);
  const embed = buildLeaderboardEmbed({ rows, nextUpdateUnix });

  const channel = await client.channels.fetch(SL_LEADERBOARD_CHANNEL_ID).catch((e) => {
    log.error({ err: e?.message }, 'failed to fetch leaderboard channel');
    return null;
  });
  if (!channel) return;

  const state = await getBotState(STATE_KEY);
  if (state?.messageId) {
    try {
      const msg = await channel.messages.fetch(state.messageId);
      await msg.edit({ embeds: [embed] });
      log.info({ messageId: state.messageId, rows: rows.length }, 'leaderboard edited');
      return;
    } catch (e) {
      log.warn({ err: e?.message, messageId: state.messageId }, 'stale leaderboard message; reposting');
    }
  }

  const newMsg = await channel.send({ embeds: [embed] });
  await setBotState(STATE_KEY, { channelId: channel.id, messageId: newMsg.id });
  log.info({ messageId: newMsg.id, rows: rows.length }, 'leaderboard posted (new message)');
}

const scheduler = createScheduler({
  name: 'slLeaderboardScheduler',
  intervalMs: SL_LEADERBOARD_INTERVAL_MS,
  tick
});

export function startScheduler(client) {
  scheduler.start(client);
}
export function stopScheduler() {
  scheduler.stop();
}
