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
    `INSERT IGNORE INTO seeding_config (id, seed_threshold, reset_threshold, daily_hour, timezone)
     VALUES (1, ?, ?, ?, ?)`,
    [
      defaults.defaultThreshold || 40,
      defaults.defaultResetThreshold || 20,
      defaults.defaultHour || 16,
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

export async function getAverageSeedTime(days = 30) {
  const rows = await query(
    `SELECT
       AVG(duration_minutes) as avg_minutes,
       COUNT(*) as total_sessions,
       MIN(duration_minutes) as fastest,
       MAX(duration_minutes) as slowest
     FROM seeding_sessions
     WHERE status = 'completed' AND started_at > NOW() - INTERVAL ? DAY`,
    [days]
  );
  const row = rows[0];
  if (!row || !row.total_sessions) {
    return { avgMinutes: null, totalSessions: 0, fastest: null, slowest: null };
  }
  return {
    avgMinutes: Math.round(row.avg_minutes),
    totalSessions: row.total_sessions,
    fastest: row.fastest,
    slowest: row.slowest,
  };
}
