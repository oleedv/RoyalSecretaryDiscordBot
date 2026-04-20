import { query } from '../../database/connection.js';
import config from '../../config.js';
import logger from '../../logger.js';

const log = logger.child({ module: 'seedingService' });

// ── Config ──

export async function getSeedingConfig() {
  const rows = await query('SELECT * FROM seeding_config WHERE id = 1');
  if (rows[0]) return rows[0];

  // Insert default row from settings fallback
  const defaults = config.seeding || {};
  await query(
    `INSERT IGNORE INTO seeding_config (id, seed_threshold, reset_threshold, daily_time, timezone)
     VALUES (1, ?, ?, ?, ?)`,
    [
      defaults.defaultThreshold || 40,
      defaults.defaultResetThreshold || 20,
      defaults.defaultTime || '16:00',
      defaults.defaultTimezone || 'UTC',
    ]
  );
  const inserted = await query('SELECT * FROM seeding_config WHERE id = 1');
  return inserted[0] || null;
}

export async function isSeedingEnabled() {
  const cfg = await getSeedingConfig();
  return !!cfg?.enabled;
}

export async function setLastDailyCallDate(date) {
  await query(
    'UPDATE seeding_config SET last_daily_call_date = ? WHERE id = 1',
    [date]
  );
}

export async function setPanelMessageId(messageId) {
  await query(
    'UPDATE seeding_config SET panel_message_id = ? WHERE id = 1',
    [messageId]
  );
}

export async function setLastResetDate(date) {
  await query(
    'UPDATE seeding_config SET last_reset_date = ? WHERE id = 1',
    [date]
  );
}

// ── Sessions ──

export async function getActiveSession() {
  const rows = await query(
    'SELECT * FROM seeding_sessions WHERE status = ? LIMIT 1',
    ['active']
  );
  return rows[0] || null;
}

export async function startSession(mapName, layerName, playerCount) {
  const result = await query(
    `INSERT INTO seeding_sessions (map_name, layer_name, start_players, peak_players)
     VALUES (?, ?, ?, ?)`,
    [mapName, layerName, playerCount, playerCount]
  );
  log.info({ mapName, layerName, playerCount }, 'Seeding session started');
  return { id: Number(result.insertId) };
}

export async function completeSession(sessionId, endPlayers) {
  await query(
    `UPDATE seeding_sessions
     SET status = 'completed', completed_at = NOW(),
         duration_minutes = TIMESTAMPDIFF(MINUTE, started_at, NOW()),
         end_players = ?
     WHERE id = ?`,
    [endPlayers, sessionId]
  );
  log.info({ sessionId, endPlayers }, 'Seeding session completed');
}

export async function resetSession(sessionId) {
  await query(
    "UPDATE seeding_sessions SET status = 'reset' WHERE id = ?",
    [sessionId]
  );
  log.info({ sessionId }, 'Seeding session reset (population dropped)');
}

export async function updateSessionPeak(sessionId, playerCount) {
  await query(
    'UPDATE seeding_sessions SET peak_players = GREATEST(peak_players, ?) WHERE id = ?',
    [playerCount, sessionId]
  );
}

export async function updateSessionCallMessage(sessionId, messageId) {
  await query(
    'UPDATE seeding_sessions SET call_message_id = ? WHERE id = ?',
    [messageId, sessionId]
  );
}

export async function expireOldSessions() {
  const result = await query(
    "UPDATE seeding_sessions SET status = 'expired' WHERE status = 'active' AND started_at < NOW() - INTERVAL 12 HOUR"
  );
  if (result.affectedRows > 0) {
    log.info({ count: result.affectedRows }, 'Expired stale seeding sessions');
  }
}

// ── Messages ──

export async function trackMessage(messageId, channelId, messageType, sessionId = null) {
  await query(
    'INSERT INTO seeding_messages (message_id, channel_id, message_type, session_id) VALUES (?, ?, ?, ?)',
    [messageId, channelId, messageType, sessionId]
  );
}

// ── Stats ──

export async function getSeedingStats(days = 30) {
  const [currentRows, prevRows, totalRows, lastCompletedRows] = await Promise.all([
    query(
      `SELECT AVG(duration_minutes) as avg_minutes, COUNT(*) as total_sessions,
              MIN(duration_minutes) as fastest, MAX(duration_minutes) as slowest
       FROM seeding_sessions
       WHERE status = 'completed' AND started_at > NOW() - INTERVAL ? DAY`,
      [days]
    ),
    query(
      `SELECT AVG(duration_minutes) as avg_minutes
       FROM seeding_sessions
       WHERE status = 'completed'
         AND started_at > NOW() - INTERVAL ? DAY
         AND started_at <= NOW() - INTERVAL ? DAY`,
      [days * 2, days]
    ),
    query(
      `SELECT COUNT(*) as total_all, SUM(status = 'completed') as total_completed
       FROM seeding_sessions
       WHERE started_at > NOW() - INTERVAL ? DAY`,
      [days]
    ),
    query(
      `SELECT completed_at, duration_minutes, map_name
       FROM seeding_sessions
       WHERE status = 'completed'
       ORDER BY completed_at DESC LIMIT 1`
    ),
  ]);

  const row = currentRows[0];
  const totalRow = totalRows[0];
  const lastCompleted = lastCompletedRows[0] || null;

  const currentAvg = row?.avg_minutes ? Math.round(row.avg_minutes) : null;
  const prevAvg = prevRows[0]?.avg_minutes ? Math.round(prevRows[0].avg_minutes) : null;
  let trend = null;
  if (prevAvg != null && currentAvg != null) {
    if (currentAvg > prevAvg + 5) trend = 'up';
    else if (currentAvg < prevAvg - 5) trend = 'down';
    else trend = 'stable';
  }

  const totalAll = Number(totalRow?.total_all || 0);
  const totalCompleted = Number(totalRow?.total_completed || 0);
  const successRate = totalAll > 0 ? Math.round((totalCompleted / totalAll) * 100) : null;

  return {
    avgMinutes: currentAvg,
    totalSessions: Number(row?.total_sessions || 0),
    fastest: row?.fastest ?? null,
    slowest: row?.slowest ?? null,
    trend,
    successRate,
    totalCompleted,
    totalAll,
    lastCompletedAt: lastCompleted?.completed_at ?? null,
    lastCompletedMap: lastCompleted?.map_name ?? null,
    lastCompletedDuration: lastCompleted?.duration_minutes ?? null,
  };
}

export async function clearTrackedMessages(channelId) {
  await query('DELETE FROM seeding_messages WHERE channel_id = ?', [channelId]);
}

// ── Rapport ──

export async function getSeedingRapport(date) {
  // Query SquadJS database for per-player seeding data
  const seeders = await query(
    `SELECT
       p.last_known_name AS playerName,
       p.steam_id AS steamId,
       j.time AS joinTime,
       l.time AS leaveTime,
       l.seed_duration AS seedDuration,
       l.session_duration AS sessionDuration
     FROM squadjs_connections j
     JOIN squadjs_players p ON p.id = j.player_id
     LEFT JOIN squadjs_connections l ON l.player_id = j.player_id
       AND l.server_id = j.server_id
       AND l.event_type = 'leave'
       AND l.time > j.time
       AND l.time < j.time + INTERVAL 24 HOUR
     WHERE j.event_type = 'join'
       AND j.seed_join = 1
       AND DATE(j.time) = ?
     ORDER BY l.seed_duration DESC`,
    [date],
    'squadjs'
  )

  const uniquePlayers = new Set(seeders.map(s => s.steamId || s.playerName))
  const totalSeedSeconds = seeders.reduce((sum, s) => sum + (s.seedDuration || 0), 0)
  const seedersWithDuration = seeders.filter(s => s.seedDuration > 0)
  const avgSeedSeconds = seedersWithDuration.length > 0
    ? Math.round(totalSeedSeconds / seedersWithDuration.length)
    : 0

  return {
    date,
    totalSeeders: uniquePlayers.size,
    totalJoins: seeders.length,
    avgSeedMinutes: Math.round(avgSeedSeconds / 60),
    totalSeedMinutes: Math.round(totalSeedSeconds / 60),
    seeders: seeders.map(s => ({
      playerName: s.playerName || 'Unknown',
      steamId: s.steamId || null,
      joinTime: s.joinTime ? new Date(s.joinTime).toISOString() : null,
      leaveTime: s.leaveTime ? new Date(s.leaveTime).toISOString() : null,
      seedDurationMinutes: s.seedDuration != null ? Math.round(s.seedDuration / 60) : null,
      sessionDurationMinutes: s.sessionDuration != null ? Math.round(s.sessionDuration / 60) : null,
    })),
  }
}
