import logger from './logger.js';
import config, { validateConfig } from './config.js';
import { createPools, testConnections, closePools } from './database/connection.js';
import { initSchema } from './database/schema.js';
import { createBot } from './bot.js';
import { stopScheduler } from './services/prospect/prospectScheduler.js';
import { stopScheduler as stopSeedingScheduler } from './services/seeding/seedingScheduler.js';
import { disconnect as disconnectSquadJS } from './services/seeding/seedingSocket.js';

const log = logger.child({ module: 'main' });

async function main() {
  log.info(`Starting ${config.bot.name} v${config.bot.version}`);

  validateConfig();
  log.info('Configuration validated');

  createPools();
  const dbReady = await testConnections();
  if (!dbReady) {
    log.fatal('Cannot connect to database — exiting');
    process.exit(1);
  }

  await initSchema();

  const client = await createBot();
  await client.login(config.discord.token);

  const shutdown = async (signal) => {
    log.info(`Received ${signal}, shutting down gracefully...`);
    stopScheduler();
    stopSeedingScheduler();
    disconnectSquadJS();
    client.destroy();
    await closePools();
    log.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  log.fatal({ err }, 'Fatal startup error');
  process.exit(1);
});
