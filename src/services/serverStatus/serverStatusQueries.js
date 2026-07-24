import config from '../../config.js';
import { query } from '../../database/connection.js';
import logger from '../../logger.js';
import { coerceServerId } from '../seeding/serverResolver.js';

const log = logger.child({ module: 'serverStatusQueries' });

const serverIdCache = new Map();

/**
 * Map a SQUADJS_SERVERS connection name (or exact DB name) to squadjs_servers.id.
 *
 * Priority:
 *  1. Explicit serverId from SQUADJS_SERVERS (name|url|token|serverId) — preferred for multi-server
 *  2. Exact match on squadjs_servers.name for the connection name and any alternate names
 *     (e.g. live A2S serverName, which matches what SquadJS upserts into the DB)
 *  3. Single-server only: the sole row in squadjs_servers
 *
 * Never use "latest match" for multi-server: both Main and Battle would share the same TPS /
 * new-players stats. Prefer missing stats over wrong stats.
 */
async function getServerId(serverName, alternateNames = []) {
  if (!serverName && (!alternateNames || alternateNames.length === 0)) return null;

  if (serverName && serverIdCache.has(serverName)) return serverIdCache.get(serverName);

  // 1. Config mapping — socket names like "production"/"battle" → canonical DB id
  if (serverName) {
    const fromConfig = (config.squadjs || []).find((s) => s.name === serverName);
    const configId = coerceServerId(fromConfig?.serverId);
    if (configId != null) {
      serverIdCache.set(serverName, configId);
      return configId;
    }
  }

  const nameCandidates = [...new Set(
    [serverName, ...(alternateNames || [])].filter((n) => typeof n === 'string' && n.trim() !== '')
  )];

  try {
    // 2. Exact DB name match (connection name and/or A2S display name)
    for (const candidate of nameCandidates) {
      if (serverIdCache.has(candidate)) {
        const id = serverIdCache.get(candidate);
        if (serverName) serverIdCache.set(serverName, id);
        return id;
      }
      const rows = await query(
        'SELECT id FROM squadjs_servers WHERE name = ?',
        [candidate],
        'squadjs'
      );
      if (rows.length > 0) {
        const id = rows[0].id;
        serverIdCache.set(candidate, id);
        if (serverName) serverIdCache.set(serverName, id);
        return id;
      }
    }

    // 3. Only safe when there is exactly one game server in the DB
    const rows = await query(
      'SELECT id FROM squadjs_servers ORDER BY id ASC',
      [],
      'squadjs'
    );
    if (rows.length === 1) {
      const id = rows[0].id;
      log.info({ serverName, resolvedId: id }, 'Resolved server ID via single-server fallback');
      if (serverName) serverIdCache.set(serverName, id);
      return id;
    }

    const fromConfig = serverName
      ? (config.squadjs || []).find((s) => s.name === serverName)
      : null;
    log.warn(
      {
        serverName,
        alternateNames: nameCandidates.filter((n) => n !== serverName),
        hasConfigEntry: Boolean(fromConfig),
        configServerId: fromConfig?.serverId ?? null,
        dbServerCount: rows.length,
      },
      'Could not resolve squadjs server ID — set the 4th field of SQUADJS_SERVERS (serverId) per connection'
    );
    return null;
  } catch (err) {
    log.warn({ err, serverName }, 'Failed to look up server ID');
    return null;
  }
}

/**
 * Prefer an explicit id when callers already know it (socket connection serverId).
 * Otherwise resolve by connection name and optional alternate names (A2S display name).
 */
function resolveServerId(serverName, serverIdHint = null, alternateNames = []) {
  const hinted = coerceServerId(serverIdHint);
  if (hinted != null) return Promise.resolve(hinted);
  return getServerId(serverName, alternateNames);
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
// Optional serverIdHint avoids name→id lookup when the socket connection already has it.
export async function getRecentCompletedLayers(serverName, limit = 3, serverIdHint = null, alternateNames = []) {
  const serverId = await resolveServerId(serverName, serverIdHint, alternateNames);
  if (serverId == null) return [];
  try {
    return await fetchRecentCompletedLayers(serverId, limit);
  } catch (err) {
    log.warn({ err, serverName }, 'Failed to query recent completed layers');
    return [];
  }
}

async function fetchActiveMatch(serverId) {
  const rows = await query(
    `SELECT layer, UNIX_TIMESTAMP(start_time) AS start_ts
     FROM squadjs_matches
     WHERE server_id = ? AND end_time IS NULL
     ORDER BY start_time DESC
     LIMIT 1`,
    [serverId],
    'squadjs'
  );
  if (rows.length === 0) return null;
  return {
    layer: rows[0].layer || null,
    startTime: rows[0].start_ts != null ? Number(rows[0].start_ts) : null,
  };
}

// The current (in-progress) match: its layer + start unix ts. Sourced from the DB
// so it is available even when the live socket has no layer yet (e.g. right after a
// reboot) or is disconnected. Returns null on any failure.
// Optional serverIdHint avoids name→id lookup when the socket connection already has it.
export async function getActiveMatch(serverName, serverIdHint = null, alternateNames = []) {
  const serverId = await resolveServerId(serverName, serverIdHint, alternateNames);
  if (serverId == null) return null;
  try {
    return await fetchActiveMatch(serverId);
  } catch (err) {
    log.warn({ err, serverName }, 'Failed to query active match');
    return null;
  }
}

// Optional serverIdHint: pass the socket connection's serverId so Main and Battle
// each query their own TPS / new-players rows instead of sharing a mis-resolved id.
// alternateNames: e.g. [state.serverName] from A2S for DB name matching.
export async function getServerStats(serverName, serverIdHint = null, alternateNames = []) {
  const serverId = await resolveServerId(serverName, serverIdHint, alternateNames);
  if (serverId == null) return {};

  try {
    const [matchStartTime, tps, newPlayers] = await Promise.all([
      fetchMatchStartTime(serverId).catch((err) => {
        log.warn({ err, serverId }, 'Failed to query match start time');
        return null;
      }),
      fetchTps(serverId).catch((err) => {
        log.warn({ err, serverId }, 'Failed to query TPS');
        return null;
      }),
      fetchNewPlayers(serverId).catch((err) => {
        log.warn({ err, serverId }, 'Failed to query new players');
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
    log.warn({ err, serverName, serverId }, 'Failed to fetch server stats');
    return {};
  }
}
