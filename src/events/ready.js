import { Events } from 'discord.js';
import { ensureTicketPanel } from '../services/ticket/ticketPanel.js';
import { ensureProspectPanel } from '../services/prospect/prospectPanel.js';
import { ensureVerifyPanel } from '../services/verify/verifyPanel.js';
import { ensurePurgedPanel } from '../services/purged/purgedPanel.js';
import { startScheduler } from '../services/prospect/prospectScheduler.js';
import { connect as connectSquadJS } from '../services/seeding/seedingSocket.js';
import { startScheduler as startSeedingScheduler } from '../services/seeding/seedingScheduler.js';
import { startHeartbeat } from '../services/admin/statusHeartbeat.js';
import { startScheduler as startSeedTrackerScheduler } from '../services/seedTracker/seedTrackerScheduler.js';
import { resumeClosingTimers, restoreAnonymousModes } from '../services/ticket/ticketService.js';
import { startStatusUpdater } from '../services/serverStatus/serverStatusService.js';
import { startActionProcessor } from '../services/actionProcessor.js';
import { startScheduler as startConfigGuardian } from '../services/configGuardian/configGuardianScheduler.js';
import { recoverActiveSessions } from '../services/activity/voiceTracker.js';
import { startScheduler as startActivityScheduler } from '../services/activity/activityScheduler.js';
import logger from '../logger.js';

const log = logger.child({ module: 'bot' });

async function safeInit(label, fn) {
  try { await fn() } catch (err) { log.error({ err }, `Failed to init: ${label}`) }
}

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    log.info(`Logged in as ${client.user.tag}`);
    log.info(`Serving ${client.guilds.cache.size} guild(s)`);

    await safeInit('ticketPanel', () => ensureTicketPanel(client));
    await safeInit('prospectPanel', () => ensureProspectPanel(client));
    await safeInit('verifyPanel', () => ensureVerifyPanel(client));
    await safeInit('purgedPanel', () => ensurePurgedPanel(client));
    await safeInit('closingTimers', () => resumeClosingTimers(client));
    await safeInit('anonymousModes', () => restoreAnonymousModes());

    await safeInit('prospectScheduler', () => startScheduler(client));
    await safeInit('squadJSSocket', () => connectSquadJS(client));
    await safeInit('seedingScheduler', () => startSeedingScheduler(client));
    await safeInit('seedTrackerScheduler', () => startSeedTrackerScheduler(client));
    await safeInit('heartbeat', () => startHeartbeat(client));
    await safeInit('statusUpdater', () => startStatusUpdater(client));
    await safeInit('actionProcessor', () => startActionProcessor(client));
    await safeInit('configGuardian', () => startConfigGuardian(client));
    await safeInit('voiceRecovery', () => recoverActiveSessions(client));
    await safeInit('activityScheduler', () => startActivityScheduler());
  },
};
