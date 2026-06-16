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
import { stopScheduler as stopLayerRotationValidator } from './services/layerRotationValidator/layerRotationValidatorScheduler.js';
import { stopScheduler as stopModerationScheduler } from './services/moderation/moderationScheduler.js';
import { finalizeAllSessions } from './services/activity/voiceTracker.js';
import { stopScheduler as stopActivityScheduler } from './services/activity/activityScheduler.js';
import { flushLogs } from './services/admin/logTransport.js';
import { stopActionProcessor } from './services/actionProcessor.js';
import { stopCleanupScheduler as stopTempVoiceCleanup } from './services/tempvoice/tempvoiceManager.js';
import * as errorAlert from './services/admin/errorAlertService.js';
import * as dmLog from './services/admin/dmLogService.js';

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
      squadjsServers: (config.squadjs || []).map(s => ({ name: s.name, url: s.url, serverId: s.serverId })),
      announcerServerId: seedingCfg?.announcer_server_id ?? null,
      trackerServerId: seedingCfg?.tracker_server_id ?? null,
      seedingChannelId: seedingCfg?.channel_id ?? null,
      seedingRoleIds: seedingCfg?.role_ids ?? null,
      seedThreshold: seedingCfg?.seed_threshold ?? null,
      trackerEnabled: !!seedingCfg?.tracker_enabled,
      progressionChannelId: seedingCfg?.progression_channel_id ?? null,
      leaderboardChannelId: seedingCfg?.leaderboard_channel_id ?? null,
      moderationEnabled: !!config.moderation?.enabled,
      moderationChannelId: config.moderation?.channelId || null,
      moderationServerName: config.moderation?.productionServerName || null,
      moderationDailyTime: config.moderation?.dailyTime || null,
    }, '[boot] bot environment');
  } catch (err) {
    log.warn({ err }, '[boot] failed to log environment assertion');
  }

  const { client, commandCount, eventCount } = await createBot();
  await loginWithRetry(client, config.discord.token);

  if (!client.isReady()) {
    await new Promise((resolve) => client.once(Events.ClientReady, resolve));
  }

  errorAlert.init(client);
  dmLog.init(client);

  const bootMs = Date.now() - startedAt;
  printReadyBanner({
    client,
    commandCount,
    eventCount,
    dbStatus,
    bootMs,
  });

  await errorAlert.postStartupNotice({
    env: process.env.NODE_ENV,
    commit: process.env.GIT_COMMIT || process.env.RAILWAY_GIT_COMMIT_SHA || 'unknown',
    bootMs,
    commandCount,
    eventCount,
  }).catch(() => {});

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}, shutting down gracefully...`);
    await errorAlert.postShutdownNotice({ signal, uptimeMs: Date.now() - startedAt }).catch(() => {});
    stopScheduler();
    stopSeedingScheduler();
    stopSeedTrackerScheduler();
    disconnectSquadJS();
    stopStatusUpdater();
    stopConfigGuardian();
    stopLayerRotationValidator();
    stopModerationScheduler();
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
  errorAlert.reportError(err, { source: 'unhandledRejection', severity: 'fatal' }).catch(() => {});
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  errorAlert.reportError(err, { source: 'uncaughtException', severity: 'fatal' }).catch(() => {});
});

async function loginWithRetry(client, token, maxAttempts = 6) {
  const TRANSIENT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);
  let delayMs = 2000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await client.login(token);
      return;
    } catch (err) {
      const status = typeof err?.status === 'number' ? err.status : null;
      const isAuth = status === 401;
      const isTransient =
        (status !== null && status >= 500 && status < 600) ||
        status === 408 ||
        status === 429 ||
        TRANSIENT_CODES.has(err?.code);
      if (isAuth || !isTransient || attempt === maxAttempts) throw err;
      log.warn(
        { err: { name: err?.name, message: err?.message, status, code: err?.code }, attempt, nextDelayMs: delayMs },
        'client.login transient failure, retrying',
      );
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs = Math.min(delayMs * 2, 30000);
    }
  }
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  log.fatal({ err }, 'Fatal startup error');
  process.exit(1);
});
