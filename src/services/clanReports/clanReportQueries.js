// SQL helpers for /clanreport. All queries are parameterized.
//
// Pool layout:
//   - 'website' pool: Clan, WhitelistEntry (Prisma-managed webpage DB)
//   - 'squadjs' pool: squadjs_* (read-only game data)
//   - Cross-DB joins are not possible; we fetch steamIds from website
//     and pass them into squadjs queries via WHERE steam_id IN (?).

import { query, getPool } from '../../database/connection.js';
import logger from '../../logger.js';

const log = logger.child({ module: 'clanReports:queries' });

const SERVER = 'main';

function isWebsiteConfigured() {
  try {
    getPool('website');
    return true;
  } catch {
    return false;
  }
}

function windowPredicate(days, column) {
  if (days === null || days === undefined) return { sql: '', params: [] };
  return { sql: ` AND ${column} >= DATE_SUB(NOW(), INTERVAL ? DAY)`, params: [days] };
}

// ── Clan & server lookup ────────────────────────────────────────

export async function listClans() {
  if (!isWebsiteConfigured()) return [];
  try {
    return await query(
      'SELECT id, name, tag, createdAt FROM Clan ORDER BY name ASC LIMIT 25',
      [],
      'website'
    );
  } catch (err) {
    log.warn({ err }, 'listClans failed');
    return [];
  }
}

export async function getClan(clanId) {
  if (!isWebsiteConfigured()) return null;
  try {
    const rows = await query(
      'SELECT id, name, tag, createdAt FROM Clan WHERE id = ?',
      [clanId],
      'website'
    );
    return rows[0] || null;
  } catch (err) {
    log.warn({ err, clanId }, 'getClan failed');
    return null;
  }
}

export async function listServers() {
  try {
    return await query(
      'SELECT id, name FROM squadjs_servers ORDER BY id ASC LIMIT 25',
      [],
      'squadjs'
    );
  } catch (err) {
    log.warn({ err }, 'listServers failed');
    return [];
  }
}

export async function getServer(serverId) {
  try {
    const rows = await query(
      'SELECT id, name FROM squadjs_servers WHERE id = ?',
      [Number(serverId)],
      'squadjs'
    );
    return rows[0] || null;
  } catch (err) {
    log.warn({ err, serverId }, 'getServer failed');
    return null;
  }
}

// ── Clan members ────────────────────────────────────────────────

export async function getClanMembers(clanId) {
  if (!isWebsiteConfigured()) return [];
  try {
    return await query(
      `SELECT id, steamId, name, role, addedBy, expiresAt, createdAt
       FROM WhitelistEntry
       WHERE clanId = ?
         AND server = ?
         AND (expiresAt IS NULL OR expiresAt > NOW())
       ORDER BY role ASC, name ASC`,
      [clanId, SERVER],
      'website'
    );
  } catch (err) {
    log.warn({ err, clanId }, 'getClanMembers failed');
    return [];
  }
}

export async function countExpiringSoon(clanId, withinDays = 14) {
  if (!isWebsiteConfigured()) return 0;
  try {
    const rows = await query(
      `SELECT COUNT(*) AS n
       FROM WhitelistEntry
       WHERE clanId = ?
         AND server = ?
         AND expiresAt IS NOT NULL
         AND expiresAt > NOW()
         AND expiresAt <= DATE_ADD(NOW(), INTERVAL ? DAY)`,
      [clanId, SERVER, withinDays],
      'website'
    );
    return Number(rows[0]?.n || 0);
  } catch (err) {
    log.warn({ err, clanId }, 'countExpiringSoon failed');
    return 0;
  }
}

// ── Per-panel data ──────────────────────────────────────────────

export async function getActivityRows(steamIds, serverId, days) {
  if (steamIds.length === 0) return [];
  const win = windowPredicate(days, 'c.time');
  try {
    return await query(
      `SELECT
         p.steam_id AS steamId,
         MAX(p.name) AS name,
         MAX(p.last_seen) AS lastSeen,
         SUM(COALESCE(c.session_duration, 0)) AS totalSeconds,
         SUM(COALESCE(c.seed_duration, 0))    AS seedSeconds,
         SUM(CASE WHEN c.seed_duration > 0 THEN 1 ELSE 0 END) AS seedSessions,
         COUNT(*) AS joinCount
       FROM squadjs_players p
       JOIN squadjs_connections c ON c.player_id = p.id
       WHERE p.steam_id IN (?)
         AND c.server_id = ?
         AND c.event_type = 'leave'
         ${win.sql}
       GROUP BY p.steam_id
       ORDER BY totalSeconds DESC`,
      [steamIds, Number(serverId), ...win.params],
      'squadjs'
    );
  } catch (err) {
    log.warn({ err, serverId, days }, 'getActivityRows failed');
    return [];
  }
}

export async function getSeedingRows(steamIds, serverId, days) {
  if (steamIds.length === 0) return [];
  const win = windowPredicate(days, 's.seed_date');
  try {
    return await query(
      `SELECT
         p.steam_id AS steamId,
         MAX(p.name) AS name,
         COUNT(DISTINCT s.seed_date)                          AS seedDays,
         SUM(s.duration_seconds)                              AS seedSeconds,
         AVG(s.quality_score)                                 AS avgQuality,
         SUM(CASE WHEN s.threshold_reached THEN 1 ELSE 0 END) AS thresholdSessions,
         MAX(s.seed_date)                                     AS lastSeedDate
       FROM squadjs_players p
       JOIN squadjs_seed_sessions s ON s.player_id = p.id
       WHERE p.steam_id IN (?)
         AND s.server_id = ?
         AND s.status = 'completed'
         ${win.sql}
       GROUP BY p.steam_id
       ORDER BY seedDays DESC, seedSeconds DESC`,
      [steamIds, Number(serverId), ...win.params],
      'squadjs'
    );
  } catch (err) {
    log.warn({ err, serverId, days }, 'getSeedingRows failed');
    return [];
  }
}

export async function getCombatRows(steamIds, serverId, days) {
  if (steamIds.length === 0) return [];
  const win = windowPredicate(days, 'ce.time');
  try {
    const [attackerRows, victimRows, reviverRows] = await Promise.all([
      query(
        `SELECT
           ap.steam_id AS steamId,
           MAX(ap.name) AS name,
           SUM(CASE WHEN ce.event_type = 'death' AND ce.teamkill = 0 THEN 1 ELSE 0 END) AS kills,
           SUM(CASE WHEN ce.event_type = 'death' AND ce.teamkill = 1 THEN 1 ELSE 0 END) AS teamkillsGiven,
           SUM(CASE WHEN ce.event_type = 'wound'                       THEN 1 ELSE 0 END) AS wounds
         FROM squadjs_combat_events ce
         JOIN squadjs_players ap ON ap.id = ce.attacker_id
         WHERE ap.steam_id IN (?)
           AND ce.server_id = ?
           ${win.sql}
         GROUP BY ap.steam_id`,
        [steamIds, Number(serverId), ...win.params],
        'squadjs'
      ),
      query(
        `SELECT
           vp.steam_id AS steamId,
           SUM(CASE WHEN ce.teamkill = 0 THEN 1 ELSE 0 END) AS deaths,
           SUM(CASE WHEN ce.teamkill = 1 THEN 1 ELSE 0 END) AS teamkillsTaken
         FROM squadjs_combat_events ce
         JOIN squadjs_players vp ON vp.id = ce.victim_id
         WHERE vp.steam_id IN (?)
           AND ce.server_id = ?
           AND ce.event_type = 'death'
           ${win.sql}
         GROUP BY vp.steam_id`,
        [steamIds, Number(serverId), ...win.params],
        'squadjs'
      ),
      query(
        `SELECT rp.steam_id AS steamId, COUNT(*) AS revives
         FROM squadjs_combat_events ce
         JOIN squadjs_players rp ON rp.id = ce.reviver_id
         WHERE rp.steam_id IN (?)
           AND ce.server_id = ?
           AND ce.event_type = 'revive'
           ${win.sql}
         GROUP BY rp.steam_id`,
        [steamIds, Number(serverId), ...win.params],
        'squadjs'
      ),
    ]);

    // Merge by steamId
    const merged = new Map();
    const ensure = (steamId) => {
      let row = merged.get(steamId);
      if (!row) {
        row = { steamId, name: null, kills: 0, deaths: 0, teamkillsGiven: 0, teamkillsTaken: 0, revives: 0, wounds: 0 };
        merged.set(steamId, row);
      }
      return row;
    };
    for (const r of attackerRows) {
      const row = ensure(r.steamId);
      row.name = r.name || row.name;
      row.kills += Number(r.kills || 0);
      row.teamkillsGiven += Number(r.teamkillsGiven || 0);
      row.wounds += Number(r.wounds || 0);
    }
    for (const r of victimRows) {
      const row = ensure(r.steamId);
      row.deaths += Number(r.deaths || 0);
      row.teamkillsTaken += Number(r.teamkillsTaken || 0);
    }
    for (const r of reviverRows) {
      const row = ensure(r.steamId);
      row.revives += Number(r.revives || 0);
    }
    return [...merged.values()].sort((a, b) => b.kills - a.kills);
  } catch (err) {
    log.warn({ err, serverId, days }, 'getCombatRows failed');
    return [];
  }
}

export async function getMatchOutcomes(steamIds, serverId, days) {
  if (steamIds.length === 0) return { perMember: [], matches: [] };
  const winSb = windowPredicate(days, 'sb.time');
  const winMatch = windowPredicate(days, 'm.end_time');
  try {
    const [perMember, matchRows] = await Promise.all([
      query(
        `SELECT
           p.steam_id AS steamId,
           MAX(p.name) AS name,
           COUNT(DISTINCT sb.match_id) AS matchesPlayed,
           SUM(CASE WHEN sb.team_id = 1 THEN 1 ELSE 0 END) AS teamACount,
           SUM(CASE WHEN sb.team_id = 2 THEN 1 ELSE 0 END) AS teamBCount
         FROM squadjs_scoreboard sb
         JOIN squadjs_players p ON p.id = sb.player_id
         WHERE p.steam_id IN (?)
           AND sb.server_id = ?
           ${winSb.sql}
         GROUP BY p.steam_id
         ORDER BY matchesPlayed DESC`,
        [steamIds, Number(serverId), ...winSb.params],
        'squadjs'
      ),
      query(
        `SELECT m.id, m.layer, m.start_time, m.end_time, m.winner,
                GROUP_CONCAT(sb.team_id) AS clanTeamIds
         FROM squadjs_matches m
         JOIN squadjs_scoreboard sb ON sb.match_id = m.id
         JOIN squadjs_players p ON p.id = sb.player_id
         WHERE p.steam_id IN (?)
           AND m.server_id = ?
           AND m.end_time IS NOT NULL
           ${winMatch.sql}
         GROUP BY m.id`,
        [steamIds, Number(serverId), ...winMatch.params],
        'squadjs'
      ),
    ]);
    return { perMember, matches: matchRows };
  } catch (err) {
    log.warn({ err, serverId, days }, 'getMatchOutcomes failed');
    return { perMember: [], matches: [] };
  }
}

export async function getHourBuckets(steamIds, serverId, days) {
  if (steamIds.length === 0) return { hours: [], dows: [] };
  const win = windowPredicate(days, 'c.time');
  try {
    const [hours, dows] = await Promise.all([
      query(
        `SELECT HOUR(c.time) AS hour, COUNT(*) AS sessions
         FROM squadjs_connections c
         JOIN squadjs_players p ON p.id = c.player_id
         WHERE p.steam_id IN (?)
           AND c.server_id = ?
           AND c.event_type = 'join'
           ${win.sql}
         GROUP BY HOUR(c.time)
         ORDER BY hour`,
        [steamIds, Number(serverId), ...win.params],
        'squadjs'
      ),
      query(
        `SELECT DAYOFWEEK(c.time) AS dow, COUNT(*) AS sessions
         FROM squadjs_connections c
         JOIN squadjs_players p ON p.id = c.player_id
         WHERE p.steam_id IN (?)
           AND c.server_id = ?
           AND c.event_type = 'join'
           ${win.sql}
         GROUP BY DAYOFWEEK(c.time)
         ORDER BY dow`,
        [steamIds, Number(serverId), ...win.params],
        'squadjs'
      ),
    ]);
    return { hours, dows };
  } catch (err) {
    log.warn({ err, serverId, days }, 'getHourBuckets failed');
    return { hours: [], dows: [] };
  }
}

export async function getNewMembers(clanId, days) {
  if (!isWebsiteConfigured() || days === null || days === undefined) {
    // For "all-time" window, return everyone (capped) so the panel still has data.
    if (!isWebsiteConfigured()) return [];
  }
  try {
    if (days === null || days === undefined) {
      return await query(
        `SELECT steamId, name, role, createdAt
         FROM WhitelistEntry
         WHERE clanId = ? AND server = ?
         ORDER BY createdAt DESC
         LIMIT 100`,
        [clanId, SERVER],
        'website'
      );
    }
    return await query(
      `SELECT steamId, name, role, createdAt
       FROM WhitelistEntry
       WHERE clanId = ? AND server = ?
         AND createdAt >= DATE_SUB(NOW(), INTERVAL ? DAY)
       ORDER BY createdAt DESC`,
      [clanId, SERVER, days],
      'website'
    );
  } catch (err) {
    log.warn({ err, clanId, days }, 'getNewMembers failed');
    return [];
  }
}

export async function getExpiredOrRemoved(clanId, days) {
  if (!isWebsiteConfigured()) return [];
  try {
    if (days === null || days === undefined) {
      return await query(
        `SELECT steamId, name, role, expiresAt
         FROM WhitelistEntry
         WHERE clanId = ? AND server = ?
           AND expiresAt IS NOT NULL
           AND expiresAt < NOW()
         ORDER BY expiresAt DESC
         LIMIT 100`,
        [clanId, SERVER],
        'website'
      );
    }
    return await query(
      `SELECT steamId, name, role, expiresAt
       FROM WhitelistEntry
       WHERE clanId = ? AND server = ?
         AND expiresAt IS NOT NULL
         AND expiresAt < NOW()
         AND expiresAt >= DATE_SUB(NOW(), INTERVAL ? DAY)
       ORDER BY expiresAt DESC`,
      [clanId, SERVER, days],
      'website'
    );
  } catch (err) {
    log.warn({ err, clanId, days }, 'getExpiredOrRemoved failed');
    return [];
  }
}

export async function getLastSeenForSteamIds(steamIds) {
  if (steamIds.length === 0) return new Map();
  try {
    const rows = await query(
      `SELECT steam_id AS steamId, name, last_seen AS lastSeen
       FROM squadjs_players
       WHERE steam_id IN (?)`,
      [steamIds],
      'squadjs'
    );
    const map = new Map();
    for (const r of rows) map.set(r.steamId, r);
    return map;
  } catch (err) {
    log.warn({ err }, 'getLastSeenForSteamIds failed');
    return new Map();
  }
}

export async function getTagSpotters(tag, serverId, knownSteamIds) {
  try {
    // Sentinel so NOT IN works against an empty whitelist
    const exclude = knownSteamIds.length > 0 ? knownSteamIds : ['0'];
    const rows = await query(
      `SELECT p.steam_id AS steamId, p.name, p.last_seen AS lastSeen,
              COALESCE(SUM(c.session_duration), 0) AS totalSeconds
       FROM squadjs_players p
       LEFT JOIN squadjs_connections c
         ON c.player_id = p.id
        AND c.server_id = ?
        AND c.event_type = 'leave'
        AND c.time >= DATE_SUB(NOW(), INTERVAL 30 DAY)
       WHERE p.prefix = ?
         AND p.last_seen >= DATE_SUB(NOW(), INTERVAL 30 DAY)
         AND p.steam_id NOT IN (?)
       GROUP BY p.steam_id, p.name, p.last_seen
       ORDER BY p.last_seen DESC
       LIMIT 100`,
      [Number(serverId), tag, exclude],
      'squadjs'
    );
    return rows;
  } catch (err) {
    log.warn({ err, tag, serverId }, 'getTagSpotters failed');
    return [];
  }
}

export async function countTagSpotters(tag, knownSteamIds) {
  try {
    const exclude = knownSteamIds.length > 0 ? knownSteamIds : ['0'];
    const rows = await query(
      `SELECT COUNT(*) AS n
       FROM squadjs_players
       WHERE prefix = ?
         AND last_seen >= DATE_SUB(NOW(), INTERVAL 30 DAY)
         AND steam_id NOT IN (?)`,
      [tag, exclude],
      'squadjs'
    );
    return Number(rows[0]?.n || 0);
  } catch (err) {
    log.warn({ err, tag }, 'countTagSpotters failed');
    return 0;
  }
}

export async function getLastClanActivity(steamIds, serverId) {
  if (steamIds.length === 0) return null;
  try {
    const rows = await query(
      `SELECT p.steam_id AS steamId, p.name, p.last_seen AS lastSeen
       FROM squadjs_players p
       WHERE p.steam_id IN (?)
       ORDER BY p.last_seen DESC
       LIMIT 1`,
      [steamIds],
      'squadjs'
    );
    return rows[0] || null;
  } catch (err) {
    log.warn({ err, serverId }, 'getLastClanActivity failed');
    return null;
  }
}
