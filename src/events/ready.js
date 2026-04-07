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
import { resumeClosingTimers } from '../services/ticket/ticketService.js';
import { startStatusUpdater } from '../services/serverStatus/serverStatusService.js';
import { startActionProcessor } from '../services/actionProcessor.js';
import { startScheduler as startConfigGuardian } from '../services/configGuardian/configGuardianScheduler.js';
import logger from '../logger.js';

const log = logger.child({ module: 'bot' });

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    log.info(`Logged in as ${client.user.tag}`);
    log.info(`Serving ${client.guilds.cache.size} guild(s)`);

    try {
      await ensureTicketPanel(client);
      await ensureProspectPanel(client);
      await ensureVerifyPanel(client);
      await ensurePurgedPanel(client);
      await resumeClosingTimers(client);
    } catch (err) {
      log.error({ err }, 'Failed to initialize panels or timers');
    }

    try {
      startScheduler(client);
      connectSquadJS(client);
      startSeedingScheduler(client);
      startSeedTrackerScheduler(client);
      await startHeartbeat(client);
      await startStatusUpdater(client);
      startActionProcessor(client);
      await startConfigGuardian(client);
    } catch (err) {
      log.error({ err }, 'Failed to start background services');
    }
  },
};
