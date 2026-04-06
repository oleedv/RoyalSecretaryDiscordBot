import logger from './logger.js';
import config, { validateConfig } from './config.js';
import { createPools, testConnections, closePools } from './database/connection.js';
import { initSchema } from './database/schema.js';
import { createBot } from './bot.js';
import { stopScheduler } from './services/prospect/prospectScheduler.js';
import { stopScheduler as stopSeedingScheduler } from './services/seeding/seedingScheduler.js';
import { disconnect as disconnectSquadJS } from './services/seeding/seedingSocket.js';
import { stopHeartbeat } from './services/admin/statusHeartbeat.js';
import { stopScheduler as stopSeedTrackerScheduler } from './services/seedTracker/seedTrackerScheduler.js';
import { stopStatusUpdater } from './services/serverStatus/serverStatusService.js';
import { stopScheduler as stopConfigGuardian } from './services/configGuardian/configGuardianScheduler.js';
import { flushLogs } from './services/admin/logTransport.js';

const log = logger.child({ module: 'main' });

async function main() {
  log.info(`Starting ${config.bot.name} v${config.bot.version}`);

  validateConfig();
  log.info('Configuration validated');

  createPools();
  const dbReady = await testConnections();
  if (!dbReady) {
    log.fatal('Cannot connect to database - exiting');
    process.exit(1);
  }

  await initSchema();

  const client = await createBot();
  await client.login(config.discord.token);

  const shutdown = async (signal) => {
    log.info(`Received ${signal}, shutting down gracefully...`);
    stopScheduler();
    stopSeedingScheduler();
    stopSeedTrackerScheduler();
    disconnectSquadJS();
    stopStatusUpdater();
    stopConfigGuardian();
    await stopHeartbeat();
    await flushLogs();
    client.destroy();
    await closePools();
    log.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  log.fatal({ err }, 'Unhandled rejection');
});

main().catch((err) => {
  console.error('Fatal startup error:', err);
  log.fatal({ err }, 'Fatal startup error');
  process.exit(1);
});
