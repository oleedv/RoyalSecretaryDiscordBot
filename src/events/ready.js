import { Events } from 'discord.js';
import { ensureTicketPanel } from '../services/ticket/ticketPanel.js';
import { ensureProspectPanel } from '../services/prospect/prospectPanel.js';
import { startScheduler } from '../services/prospect/prospectScheduler.js';
import { connect as connectSquadJS } from '../services/seeding/seedingSocket.js';
import { startScheduler as startSeedingScheduler } from '../services/seeding/seedingScheduler.js';
import logger from '../logger.js';

const log = logger.child({ module: 'bot' });

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    log.info(`Logged in as ${client.user.tag}`);
    log.info(`Serving ${client.guilds.cache.size} guild(s)`);

    await ensureTicketPanel(client);
    await ensureProspectPanel(client);
    startScheduler(client);
    connectSquadJS();
    startSeedingScheduler(client);
  },
};
