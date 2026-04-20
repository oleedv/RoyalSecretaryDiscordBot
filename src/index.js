import { Events } from 'discord.js';
import logger from './logger.js';
import config, { validateConfig } from './config.js';
import { createPools, testConnections, closePools } from './database/connection.js';
import { initSchema } from './database/schema.js';
import { createBot } from './bot.js';
import { printStartupBanner, printReadyBanner, printShutdownBanner } from './utils/printBanner.js';
import { stopScheduler } from './services/prospect/prospectScheduler.js';
import { stopScheduler as stopSeedingScheduler } from './services/seeding/seedingScheduler.js';
import { getSeedingConfig } from './services/seeding/seedingService.js';
import { disconnect as disconnectSquadJS } from './services/seeding/seedingSocket.js';
import { stopHeartbeat } from './services/admin/statusHeartbeat.js';
import { stopScheduler as stopSeedTrackerScheduler } from './services/seedTracker/seedTrackerScheduler.js';
import { stopStatusUpdater } from './services/serverStatus/serverStatusService.js';
import { stopScheduler as stopConfigGuardian } from './services/configGuardian/configGuardianScheduler.js';
import { finalizeAllSessions } from './services/activity/voiceTracker.js';
import { stopScheduler as stopActivityScheduler } from './services/activity/activityScheduler.js';
import { flushLogs } from './services/admin/logTransport.js';
import { stopActionProcessor } from './services/actionProcessor.js';
import { stopCleanupScheduler as stopTempVoiceCleanup } from './services/tempvoice/tempvoiceManager.js';

const log = logger.child({ module: 'main' });

let shuttingDown = false;
const startedAt = Date.now();

async function main() {
  printStartupBanner();

  validateConfig();
  log.info('Configuration validated');

  createPools();
  const { ok: dbReady, status: dbStatus } = await testConnections();
  if (!dbReady) {
    log.fatal('Cannot connect to database - exiting');
    process.exit(1);
  }

  await initSchema();

  // Single-line environment assertion so prod/staging misconfig is obvious in logs.
  try {
    const seedingCfg = await getSeedingConfig();
    log.info({
      env: process.env.NODE_ENV,
      dbHost: config.database.host,
      secretaryDb: config.database.databases.secretary,
      websiteDb: config.database.databases.website,
      squadjsServers: (config.squadjs || []).map(s => ({ name: s.name, url: s.url })),
      seedingServer: config.seeding?.seedingServer ?? null,
      seedingChannelId: seedingCfg?.channel_id ?? null,
      seedingRoleId: seedingCfg?.role_id ?? null,
      seedThreshold: seedingCfg?.seed_threshold ?? null,
      seedTrackerProgressionChannelId: config.seedTracker?.progressionChannelId ?? null,
      seedTrackerLeaderboardChannelId: config.seedTracker?.leaderboardChannelId ?? null,
    }, '[boot] bot environment');
  } catch (err) {
    log.warn({ err }, '[boot] failed to log environment assertion');
  }

  const { client, commandCount, eventCount } = await createBot();
  await client.login(config.discord.token);

  if (!client.isReady()) {
    await new Promise((resolve) => client.once(Events.ClientReady, resolve));
  }

  printReadyBanner({
    client,
    commandCount,
    eventCount,
    dbStatus,
    bootMs: Date.now() - startedAt,
  });

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}, shutting down gracefully...`);
    stopScheduler();
    stopSeedingScheduler();
    stopSeedTrackerScheduler();
    disconnectSquadJS();
    stopStatusUpdater();
    stopConfigGuardian();
    stopActivityScheduler();
    stopActionProcessor();
    stopTempVoiceCleanup();
    await finalizeAllSessions();
    await stopHeartbeat();
    await flushLogs();
    client.destroy();
    await closePools();
    log.info('Shutdown complete');
    printShutdownBanner(signal, startedAt);
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
