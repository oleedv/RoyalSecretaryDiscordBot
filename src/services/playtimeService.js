import { query } from '../database/connection.js';

export async function getPlaytime(steamId, startDate, endDate = null) {
  const end = endDate || new Date().toISOString().slice(0, 10);

  const rows = await query(
    `SELECT
       COALESCE(SUM(c.session_duration), 0) AS totalSession,
       COALESCE(SUM(c.seed_duration), 0) AS totalSeed
     FROM squadjs_connections c
     JOIN squadjs_players p ON p.id = c.player_id
     WHERE p.steam_id = ?
       AND c.event_type = 'leave'
       AND c.time >= ?
       AND c.time <= ?`,
    [steamId, startDate, end],
    'squadjs'
  );

  const row = rows[0] || { totalSession: 0, totalSeed: 0 };
  return {
    playtimeHours: Math.round((Number(row.totalSession) / 3600) * 10) / 10,
    seedHours: Math.round((Number(row.totalSeed) / 3600) * 10) / 10,
  };
}
