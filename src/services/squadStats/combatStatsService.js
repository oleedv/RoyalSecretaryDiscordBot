import { query } from '../../database/connection.js';
import logger from '../../logger.js';

const log = logger.child({ module: 'combatStats' });

const TOP_N = 5;

function toInt(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'bigint') return Number(v);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toFloat(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'bigint') return Number(v);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function getCombatStats(steamId, days = 30) {
  if (!steamId) return null;

  const playerRows = await query(
    'SELECT id, eos_id, steam_id, name FROM squadjs_players WHERE steam_id = ? LIMIT 1',
    [String(steamId)],
    'squadjs'
  );
  const player = playerRows[0];
  if (!player) {
    return {
      windowDays: days,
      player: null,
      kills: 0, deaths: 0, kd: 0,
      tksCommitted: 0, tksReceived: 0,
      teamDamageDealt: 0, teamDamageReceived: 0,
      topWeapons: [], topTkVictims: [], topTkAttackers: [],
      firstEvent: null, lastEvent: null,
    };
  }

  const playerId = player.id;
  const windowClause = 'time >= DATE_SUB(NOW(), INTERVAL ? DAY)';

  const [asAttacker, asVictim, topWeaponsRows, topTkVictimsRows, topTkAttackersRows, rangeRows] = await Promise.all([
    query(
      `SELECT
         SUM(event_type = 'death' AND teamkill = 0) AS kills,
         SUM(event_type = 'death' AND teamkill = 1) AS tksCommitted,
         SUM(CASE WHEN teamkill = 1 THEN damage ELSE 0 END) AS teamDamageDealt
       FROM squadjs_combat_events
       WHERE attacker_id = ? AND ${windowClause}`,
      [playerId, days],
      'squadjs'
    ),
    query(
      `SELECT
         SUM(event_type = 'death' AND teamkill = 0) AS deaths,
         SUM(event_type = 'death' AND teamkill = 1) AS tksReceived,
         SUM(CASE WHEN teamkill = 1 THEN damage ELSE 0 END) AS teamDamageReceived
       FROM squadjs_combat_events
       WHERE victim_id = ? AND ${windowClause}`,
      [playerId, days],
      'squadjs'
    ),
    query(
      `SELECT weapon, COUNT(*) AS count
       FROM squadjs_combat_events
       WHERE attacker_id = ? AND event_type = 'death' AND ${windowClause}
         AND weapon IS NOT NULL AND weapon <> ''
       GROUP BY weapon
       ORDER BY count DESC
       LIMIT ?`,
      [playerId, days, TOP_N],
      'squadjs'
    ),
    query(
      `SELECT p.steam_id AS steamId, p.name AS name, COUNT(*) AS count
       FROM squadjs_combat_events ce
       JOIN squadjs_players p ON p.id = ce.victim_id
       WHERE ce.attacker_id = ? AND ce.teamkill = 1 AND ce.event_type = 'death' AND ce.${windowClause}
       GROUP BY p.id, p.steam_id, p.name
       ORDER BY count DESC
       LIMIT ?`,
      [playerId, days, TOP_N],
      'squadjs'
    ),
    query(
      `SELECT p.steam_id AS steamId, p.name AS name, COUNT(*) AS count
       FROM squadjs_combat_events ce
       JOIN squadjs_players p ON p.id = ce.attacker_id
       WHERE ce.victim_id = ? AND ce.teamkill = 1 AND ce.event_type = 'death' AND ce.${windowClause}
       GROUP BY p.id, p.steam_id, p.name
       ORDER BY count DESC
       LIMIT ?`,
      [playerId, days, TOP_N],
      'squadjs'
    ),
    query(
      `SELECT MIN(time) AS firstEvent, MAX(time) AS lastEvent
       FROM squadjs_combat_events
       WHERE (attacker_id = ? OR victim_id = ?) AND ${windowClause}`,
      [playerId, playerId, days],
      'squadjs'
    ),
  ]);

  const a = asAttacker[0] || {};
  const v = asVictim[0] || {};
  const r = rangeRows[0] || {};

  const kills = toInt(a.kills);
  const deaths = toInt(v.deaths);
  const kd = deaths === 0 ? kills : Math.round((kills / deaths) * 100) / 100;

  return {
    windowDays: days,
    player: {
      id: player.id,
      name: player.name,
      steamId: player.steam_id,
      eosId: player.eos_id,
    },
    kills,
    deaths,
    kd,
    tksCommitted: toInt(a.tksCommitted),
    tksReceived: toInt(v.tksReceived),
    teamDamageDealt: Math.round(toFloat(a.teamDamageDealt)),
    teamDamageReceived: Math.round(toFloat(v.teamDamageReceived)),
    topWeapons: topWeaponsRows.map((row) => ({ weapon: row.weapon, count: toInt(row.count) })),
    topTkVictims: topTkVictimsRows.map((row) => ({ steamId: row.steamId, name: row.name, count: toInt(row.count) })),
    topTkAttackers: topTkAttackersRows.map((row) => ({ steamId: row.steamId, name: row.name, count: toInt(row.count) })),
    firstEvent: r.firstEvent || null,
    lastEvent: r.lastEvent || null,
  };
}

export function formatCombatStatsForAi(stats) {
  if (!stats || !stats.player) return '';

  const lines = [];
  lines.push(`Player: ${stats.player.name || '(unknown)'} | Steam: ${stats.player.steamId || '?'}`);
  lines.push(`Window: last ${stats.windowDays} days (OUR server only — cross-server TK history is NOT reflected here).`);
  lines.push(`Kills: ${stats.kills} | Deaths: ${stats.deaths} | K/D: ${stats.kd}`);
  lines.push(`Teamkills committed: ${stats.tksCommitted} (team damage dealt: ${stats.teamDamageDealt})`);
  lines.push(`Teamkills received: ${stats.tksReceived} (team damage received: ${stats.teamDamageReceived})`);

  if (stats.topWeapons.length > 0) {
    const wpn = stats.topWeapons.map((w) => `${w.weapon} (${w.count})`).join(', ');
    lines.push(`Top weapons (kills): ${wpn}`);
  }
  if (stats.topTkVictims.length > 0) {
    const vics = stats.topTkVictims.map((t) => `${t.name || t.steamId || '?'} x${t.count}`).join(', ');
    lines.push(`Most-teamkilled teammates: ${vics}`);
  }
  if (stats.topTkAttackers.length > 0) {
    const atks = stats.topTkAttackers.map((t) => `${t.name || t.steamId || '?'} x${t.count}`).join(', ');
    lines.push(`Most frequent TK attackers against this player: ${atks}`);
  }
  if (stats.firstEvent && stats.lastEvent) {
    const first = new Date(stats.firstEvent).toISOString().slice(0, 10);
    const last = new Date(stats.lastEvent).toISOString().slice(0, 10);
    lines.push(`Combat activity range: ${first} to ${last}`);
  }

  return lines.join('\n');
}

export function combatStatsUnavailableMessage(steamId) {
  return `No SquadJS combat data found for Steam ID ${steamId} on our server.`;
}

export async function getProspectStats(steamId, startDate, endDate = null) {
  if (!steamId) return null;

  const playerRows = await query(
    'SELECT id FROM squadjs_players WHERE steam_id = ? LIMIT 1',
    [String(steamId)],
    'squadjs'
  );
  const player = playerRows[0];
  if (!player) {
    return { kills: 0, deaths: 0, teamkills: 0, daysActive: 0 };
  }

  const end = endDate || new Date().toISOString().slice(0, 10);
  const playerId = player.id;

  const [combatRows, daysRows] = await Promise.all([
    query(
      `SELECT
         SUM(attacker_id = ? AND event_type = 'death' AND teamkill = 0) AS kills,
         SUM(victim_id = ? AND event_type = 'death') AS deaths,
         SUM(attacker_id = ? AND event_type = 'death' AND teamkill = 1) AS teamkills
       FROM squadjs_combat_events
       WHERE (attacker_id = ? OR victim_id = ?)
         AND time >= ?
         AND time < DATE_ADD(?, INTERVAL 1 DAY)`,
      [playerId, playerId, playerId, playerId, playerId, startDate, end],
      'squadjs'
    ),
    query(
      `SELECT COUNT(DISTINCT DATE(time)) AS daysActive
       FROM squadjs_connections
       WHERE player_id = ?
         AND event_type = 'join'
         AND time >= ?
         AND time < DATE_ADD(?, INTERVAL 1 DAY)`,
      [playerId, startDate, end],
      'squadjs'
    ),
  ]);

  const c = combatRows[0] || {};
  const d = daysRows[0] || {};
  return {
    kills: toInt(c.kills),
    deaths: toInt(c.deaths),
    teamkills: toInt(c.teamkills),
    daysActive: toInt(d.daysActive),
  };
}

export { log as combatStatsLog };
