import { query } from '../../database/connection.js';
import logger from '../../logger.js';

const log = logger.child({ module: 'activityService' });

export function incrementMessageCount(userId, channelId, channelName) {
  query(
    `INSERT INTO message_activity_daily (user_id, channel_id, channel_name, message_date, message_count)
     VALUES (?, ?, ?, CURDATE(), 1)
     ON DUPLICATE KEY UPDATE message_count = message_count + 1, channel_name = VALUES(channel_name)`,
    [userId, channelId, channelName]
  ).catch((err) => log.debug({ err, userId }, 'Failed to increment message count'));
}

export function incrementReactionCount(userId) {
  query(
    `INSERT INTO user_reactions_daily (user_id, reaction_date, reaction_count)
     VALUES (?, CURDATE(), 1)
     ON DUPLICATE KEY UPDATE reaction_count = reaction_count + 1`,
    [userId]
  ).catch((err) => log.debug({ err, userId }, 'Failed to increment reaction count'));
}

export async function getVoiceStats(userId, startDate, endDate) {
  const rows = await query(
    `SELECT
       COALESCE(SUM(duration_seconds), 0) AS totalSeconds,
       COALESCE(SUM(muted_seconds), 0) AS mutedSeconds,
       COALESCE(SUM(deafened_seconds), 0) AS deafenedSeconds,
       COALESCE(SUM(streaming_seconds), 0) AS streamingSeconds,
       COALESCE(SUM(video_seconds), 0) AS videoSeconds,
       COUNT(*) AS sessionCount
     FROM voice_sessions
     WHERE user_id = ? AND joined_at >= ? AND joined_at < DATE_ADD(?, INTERVAL 1 DAY) AND left_at IS NOT NULL`,
    [userId, startDate, endDate]
  );

  const topChannels = await query(
    `SELECT channel_name, channel_id,
       SUM(duration_seconds) AS totalSeconds
     FROM voice_sessions
     WHERE user_id = ? AND joined_at >= ? AND joined_at < DATE_ADD(?, INTERVAL 1 DAY) AND left_at IS NOT NULL AND channel_name IS NOT NULL
     GROUP BY channel_id, channel_name
     ORDER BY totalSeconds DESC
     LIMIT 5`,
    [userId, startDate, endDate]
  );

  const row = rows[0];
  return {
    totalSeconds: Number(row.totalSeconds),
    mutedSeconds: Number(row.mutedSeconds),
    deafenedSeconds: Number(row.deafenedSeconds),
    streamingSeconds: Number(row.streamingSeconds),
    videoSeconds: Number(row.videoSeconds),
    sessionCount: Number(row.sessionCount),
    topChannels: topChannels.map((c) => ({
      name: c.channel_name,
      id: c.channel_id,
      seconds: Number(c.totalSeconds),
    })),
  };
}

export async function getMessageStats(userId, startDate, endDate) {
  const totalRows = await query(
    `SELECT COALESCE(SUM(message_count), 0) AS total
     FROM message_activity_daily
     WHERE user_id = ? AND message_date >= ? AND message_date <= ?`,
    [userId, startDate, endDate]
  );

  const topChannels = await query(
    `SELECT channel_name, channel_id,
       SUM(message_count) AS total
     FROM message_activity_daily
     WHERE user_id = ? AND message_date >= ? AND message_date <= ? AND channel_name IS NOT NULL
     GROUP BY channel_id, channel_name
     ORDER BY total DESC
     LIMIT 5`,
    [userId, startDate, endDate]
  );

  return {
    totalMessages: Number(totalRows[0].total),
    topChannels: topChannels.map((c) => ({
      name: c.channel_name,
      id: c.channel_id,
      count: Number(c.total),
    })),
  };
}

export async function getReactionStats(userId, startDate, endDate) {
  const rows = await query(
    `SELECT COALESCE(SUM(reaction_count), 0) AS total
     FROM user_reactions_daily
     WHERE user_id = ? AND reaction_date >= ? AND reaction_date <= ?`,
    [userId, startDate, endDate]
  );

  return { totalReactions: Number(rows[0].total) };
}

export async function getActivitySummary(userId, startDate, endDate) {
  const [voice, messages, reactions] = await Promise.all([
    getVoiceStats(userId, startDate, endDate),
    getMessageStats(userId, startDate, endDate),
    getReactionStats(userId, startDate, endDate),
  ]);

  return { voice, messages, reactions };
}

export async function getDailyVoiceBreakdown(userId, startDate, endDate) {
  const rows = await query(
    `SELECT DATE(joined_at) AS day, COALESCE(SUM(duration_seconds), 0) AS seconds
     FROM voice_sessions
     WHERE user_id = ? AND joined_at >= ? AND joined_at < DATE_ADD(?, INTERVAL 1 DAY) AND left_at IS NOT NULL
     GROUP BY DATE(joined_at)
     ORDER BY day`,
    [userId, startDate, endDate]
  );
  return rows.map((r) => ({ date: r.day, seconds: Number(r.seconds) }));
}

export async function getDailyMessageBreakdown(userId, startDate, endDate) {
  const rows = await query(
    `SELECT message_date AS day, SUM(message_count) AS count
     FROM message_activity_daily
     WHERE user_id = ? AND message_date >= ? AND message_date <= ?
     GROUP BY message_date
     ORDER BY day`,
    [userId, startDate, endDate]
  );
  return rows.map((r) => ({ date: r.day, count: Number(r.count) }));
}

export async function getAfkVoiceSeconds(userId, startDate, endDate, afkChannelId) {
  if (!afkChannelId) return 0;
  const rows = await query(
    `SELECT COALESCE(SUM(duration_seconds), 0) AS seconds
     FROM voice_sessions
     WHERE user_id = ? AND channel_id = ? AND joined_at >= ? AND joined_at < DATE_ADD(?, INTERVAL 1 DAY) AND left_at IS NOT NULL`,
    [userId, afkChannelId, startDate, endDate]
  );
  return Number(rows[0].seconds);
}
