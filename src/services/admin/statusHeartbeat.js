import { query } from '../../database/connection.js';
import { isConnected as isSquadJsConnected } from '../seeding/seedingSocket.js';
import { isSchedulerActive as isSeedingActive } from '../seeding/seedingScheduler.js';

let heartbeatInterval = null;
let botStartedAt = null;

export async function startHeartbeat(client) {
  botStartedAt = new Date();

  // Insert initial row if missing
  await query(
    `INSERT IGNORE INTO bot_status (id, status, started_at) VALUES (1, 'online', ?)`,
    [botStartedAt]
  ).catch(() => {});

  heartbeatInterval = setInterval(() => tick(client), 60000);
  tick(client);
}

export async function stopHeartbeat() {
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }

  await query(
    `UPDATE bot_status SET status = 'offline' WHERE id = 1`
  ).catch(() => {});
}

async function tick(client) {
  try {
    let dbConnected = 0;
    try { await query('SELECT 1'); dbConnected = 1; } catch { /* noop */ }

    const memberCount = client.guilds.cache.reduce((sum, g) => sum + g.memberCount, 0);

    await query(
      `UPDATE bot_status SET
        status = 'online',
        uptime_seconds = ?,
        guild_count = ?,
        member_count = ?,
        latency_ms = ?,
        db_connected = ?,
        squadjs_connected = ?,
        seeding_scheduler_active = ?,
        prospect_scheduler_active = 0,
        started_at = COALESCE(started_at, ?)
      WHERE id = 1`,
      [
        Math.round(process.uptime()),
        client.guilds.cache.size,
        memberCount,
        client.ws.ping,
        dbConnected,
        isSquadJsConnected() ? 1 : 0,
        isSeedingActive() ? 1 : 0,
        botStartedAt,
      ]
    );
  } catch {
    // Silently fail - if DB is down, heartbeat can't write anyway
  }
}
