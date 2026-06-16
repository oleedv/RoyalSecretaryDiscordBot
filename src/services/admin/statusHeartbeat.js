import { query } from '../../database/connection.js';
import { getAllServerStates } from '../seeding/seedingSocket.js';
import { isSchedulerActive as isSeedingActive } from '../seeding/seedingScheduler.js';
import { isSchedulerActive as isProspectActive } from '../prospect/prospectScheduler.js';
import logger from '../../logger.js';
import { reportError } from './errorAlertService.js';

const log = logger.child({ module: 'statusHeartbeat' });

let heartbeatInterval = null;
let botStartedAt = null;

export async function startHeartbeat(client) {
  botStartedAt = new Date();

  // Insert initial row if missing
  await query(
    `INSERT IGNORE INTO bot_status (id, status, started_at) VALUES (1, 'online', ?)`,
    [botStartedAt]
  ).catch(() => {});

  heartbeatInterval = setInterval(() => tick(client), 30000);
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
    await writeBeat(client);
  } catch (err) {
    log.warn({ err: err.message }, 'Heartbeat tick failed, retrying in 5s');
    setTimeout(() => retryTick(client), 5000);
  }
}

async function retryTick(client) {
  try {
    await writeBeat(client);
    log.info('Heartbeat retry succeeded');
  } catch (err) {
    log.error({ err: err.message }, 'Heartbeat retry also failed');
    reportError(err, { source: 'scheduler:statusHeartbeat' }).catch(() => {});
  }
}

async function writeBeat(client) {
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
      prospect_scheduler_active = ?,
      started_at = COALESCE(started_at, ?)
    WHERE id = 1`,
    [
      Math.round(process.uptime()),
      client.guilds.cache.size,
      memberCount,
      client.ws.ping,
      dbConnected,
      getAllServerStates().some(s => s.state.connected) ? 1 : 0,
      isSeedingActive() ? 1 : 0,
      isProspectActive() ? 1 : 0,
      botStartedAt,
    ]
  );
}
