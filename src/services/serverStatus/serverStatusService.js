import config from '../../config.js';
import logger from '../../logger.js';
import { getAllServerStates } from '../seeding/seedingSocket.js';
import { getSeedingConfig } from '../seeding/seedingService.js';
import { buildServerStatusEmbed } from './serverStatusEmbeds.js';

const log = logger.child({ module: 'serverStatus' });

let updateInterval = null;
const statusMessages = []; // [{ name, messageId }]

async function findExistingMessages(channel, client, serverCount) {
  const messages = await channel.messages.fetch({ limit: 20 });
  const botMessages = messages
    .filter((msg) => msg.author.id === client.user.id && msg.embeds.length > 0)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  return [...botMessages.values()].slice(0, serverCount);
}

async function ensureMessages(channel, client, serverStates, threshold) {
  const existing = await findExistingMessages(channel, client, serverStates.length);

  for (let i = 0; i < serverStates.length; i++) {
    const { name, state } = serverStates[i];

    if (existing[i]) {
      statusMessages.push({ name, messageId: existing[i].id });
      log.info({ name, messageId: existing[i].id }, 'Found existing status message');
    } else {
      const embed = buildServerStatusEmbed(state, threshold);
      const msg = await channel.send({ embeds: [embed] });
      statusMessages.push({ name, messageId: msg.id });
      log.info({ name, messageId: msg.id }, 'Created new status message');
    }
  }
}

async function updateMessages(channel, client) {
  try {
    const serverStates = getAllServerStates();
    if (!serverStates.length) return;

    const seedCfg = await getSeedingConfig();
    const threshold = seedCfg?.seed_threshold ?? config.seeding?.defaultThreshold ?? 40;

    for (let i = 0; i < statusMessages.length; i++) {
      const entry = statusMessages[i];
      const serverData = serverStates.find((s) => s.name === entry.name);
      if (!serverData) continue;

      const embed = buildServerStatusEmbed(serverData.state, threshold);

      let msg = await channel.messages.fetch(entry.messageId).catch(() => null);
      if (msg) {
        await msg.edit({ embeds: [embed] });
      } else {
        msg = await channel.send({ embeds: [embed] });
        entry.messageId = msg.id;
        log.info({ name: entry.name, messageId: msg.id }, 'Recreated status message');
      }
    }
  } catch (err) {
    log.error({ err }, 'Failed to update server status messages');
  }
}

export async function startStatusUpdater(client) {
  const channelId = config.serverStatus?.channelId;
  if (!channelId) {
    log.warn('No serverStatus.channelId configured - skipping status updater');
    return;
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    log.warn({ channelId }, 'Server status channel not found');
    return;
  }

  const serverStates = getAllServerStates();
  if (!serverStates.length) {
    log.warn('No SquadJS servers connected - status updater will start with empty state');
  }

  const seedCfg = await getSeedingConfig();
  const threshold = seedCfg?.seed_threshold ?? config.seeding?.defaultThreshold ?? 40;

  // If no server states yet, create placeholder entries from config
  const servers = serverStates.length
    ? serverStates
    : (config.squadjs || []).map((s) => ({ name: s.name, state: { playerCount: 0, connected: false, players: [], publicSlots: 0, reserveSlots: 0, publicQueue: 0, reserveQueue: 0, gameVersion: null, currentLayer: null, currentLayerObj: null, serverName: null, currentMap: null } }));

  if (servers.length) {
    await ensureMessages(channel, client, servers, threshold);
  }

  const intervalMs = config.serverStatus?.updateIntervalMs ?? 60000;
  updateInterval = setInterval(() => updateMessages(channel, client), intervalMs);
  log.info({ channelId, intervalMs, serverCount: servers.length }, 'Server status updater started');
}

export function stopStatusUpdater() {
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
    statusMessages.length = 0;
    log.info('Server status updater stopped');
  }
}
