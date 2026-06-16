import { query } from '../../database/connection.js';
import logger from '../../logger.js';

const log = logger.child({ module: 'serverStatusQueries' });

const serverIdCache = new Map();

async function getServerId(serverName) {
  if (serverIdCache.has(serverName)) return serverIdCache.get(serverName);

  try {
    // Try exact name match first
    let rows = await query(
      'SELECT id FROM squadjs_servers WHERE name = ?',
      [serverName],
      'squadjs'
    );
    if (rows.length > 0) {
      serverIdCache.set(serverName, rows[0].id);
      return rows[0].id;
    }

    // Fallback: socket names (e.g. "production") won't match DB names
    // (e.g. "RB | Royal Battalion [ENG] Battle server"). Use the server
    // with the most recent active match instead.
    rows = await query(
      `SELECT s.id FROM squadjs_servers s
       JOIN squadjs_matches m ON m.server_id = s.id
       ORDER BY m.start_time DESC LIMIT 1`,
      [],
      'squadjs'
    );
    if (rows.length > 0) {
      log.info({ serverName, resolvedId: rows[0].id }, 'Resolved server ID via latest match fallback');
      serverIdCache.set(serverName, rows[0].id);
      return rows[0].id;
    }

    log.warn({ serverName }, 'No servers found in squadjs_servers');
    return null;
  } catch (err) {
    log.warn({ err, serverName }, 'Failed to look up server ID');
    return null;
  }
}

async function fetchMatchStartTime(serverId) {
  const rows = await query(
    `SELECT UNIX_TIMESTAMP(start_time) as start_ts
     FROM squadjs_matches
     WHERE server_id = ? AND end_time IS NULL
     ORDER BY start_time DESC
     LIMIT 1`,
    [serverId],
    'squadjs'
  );
  return rows.length > 0 && rows[0].start_ts != null
    ? Number(rows[0].start_ts)
    : null;
}

async function fetchTps(serverId) {
  const rows = await query(
    `SELECT ROUND(AVG(tick_rate), 1) as avg_tps,
            ROUND(MIN(tick_rate), 1) as min_tps,
            ROUND(MAX(tick_rate), 1) as max_tps
     FROM squadjs_tick_rates
     WHERE server_id = ?
       AND time >= DATE_SUB(NOW(), INTERVAL 10 MINUTE)
       AND tick_rate IS NOT NULL`,
    [serverId],
    'squadjs'
  );
  if (rows.length > 0 && rows[0].avg_tps != null) {
    return {
      avgTps: Number(rows[0].avg_tps),
      minTps: Number(rows[0].min_tps),
      maxTps: Number(rows[0].max_tps),
    };
  }
  return null;
}

async function fetchNewPlayers(serverId) {
  const rows = await query(
    `SELECT COUNT(DISTINCT c.player_id) as new_players
     FROM squadjs_connections c
     WHERE c.server_id = ?
       AND c.event_type = 'join'
       AND c.time >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
       AND NOT EXISTS (
         SELECT 1 FROM squadjs_connections c2
         WHERE c2.player_id = c.player_id AND c2.server_id = c.server_id
           AND c2.time < DATE_SUB(NOW(), INTERVAL 1 HOUR)
       )`,
    [serverId],
    'squadjs'
  );
  return rows.length > 0 && rows[0].new_players != null
    ? Number(rows[0].new_players)
    : 0;
}

async function fetchRecentCompletedLayers(serverId, limit) {
  // limit is internal (always small); coerce to a bounded integer so it can be
  // inlined safely (LIMIT does not bind cleanly as a placeholder in mysql2).
  const n = Math.max(1, Math.min(10, Math.trunc(Number(limit)) || 3));
  const rows = await query(
    `SELECT layer FROM squadjs_matches
     WHERE server_id = ? AND end_time IS NOT NULL AND layer IS NOT NULL AND layer <> ''
     ORDER BY start_time DESC
     LIMIT ${n}`,
    [serverId],
    'squadjs'
  );
  return rows.map((r) => r.layer);
}

// The most recently completed layers on a server, most-recent first. Returns []
// on any failure (unknown server, query error) so callers can render without it.
export async function getRecentCompletedLayers(serverName, limit = 3) {
  const serverId = await getServerId(serverName);
  if (serverId == null) return [];
  try {
    return await fetchRecentCompletedLayers(serverId, limit);
  } catch (err) {
    log.warn({ err, serverName }, 'Failed to query recent completed layers');
    return [];
  }
}

export async function getServerStats(serverName) {
  const serverId = await getServerId(serverName);
  if (serverId == null) return {};

  try {
    const [matchStartTime, tps, newPlayers] = await Promise.all([
      fetchMatchStartTime(serverId).catch((err) => {
        log.warn({ err }, 'Failed to query match start time');
        return null;
      }),
      fetchTps(serverId).catch((err) => {
        log.warn({ err }, 'Failed to query TPS');
        return null;
      }),
      fetchNewPlayers(serverId).catch((err) => {
        log.warn({ err }, 'Failed to query new players');
        return 0;
      }),
    ]);

    return {
      matchStartTime,
      avgTps: tps?.avgTps ?? null,
      minTps: tps?.minTps ?? null,
      maxTps: tps?.maxTps ?? null,
      newPlayers1h: newPlayers,
    };
  } catch (err) {
    log.warn({ err, serverName }, 'Failed to fetch server stats');
    return {};
  }
}
