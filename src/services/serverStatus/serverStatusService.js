import config from '../../config.js';
import logger from '../../logger.js';
import { getServerState } from '../seeding/seedingSocket.js';
import { getSeedingConfig } from '../seeding/seedingService.js';
import { buildServerStatusEmbed } from './serverStatusEmbeds.js';

const log = logger.child({ module: 'serverStatus' });

let updateInterval = null;
let statusMessageId = null;

async function findOrCreateMessage(channel, client) {
  const messages = await channel.messages.fetch({ limit: 10 });
  const existing = messages.find(
    (msg) => msg.author.id === client.user.id && msg.embeds.length > 0
  );

  if (existing) {
    statusMessageId = existing.id;
    log.info({ messageId: statusMessageId }, 'Found existing status message');
    return existing;
  }

  const state = getServerState();
  const seedCfg = await getSeedingConfig();
  const threshold = seedCfg?.seed_threshold ?? config.seeding?.defaultThreshold ?? 40;
  const embed = buildServerStatusEmbed(state, threshold);
  const msg = await channel.send({ embeds: [embed] });
  statusMessageId = msg.id;
  log.info({ messageId: statusMessageId }, 'Created new status message');
  return msg;
}

async function updateMessage(channel, client) {
  try {
    const state = getServerState();
    if (!state.connected) {
      log.debug('SquadJS not connected, skipping status update');
      return;
    }

    const seedCfg = await getSeedingConfig();
    const threshold = seedCfg?.seed_threshold ?? config.seeding?.defaultThreshold ?? 40;
    const embed = buildServerStatusEmbed(state, threshold);

    let msg;
    if (statusMessageId) {
      msg = await channel.messages.fetch(statusMessageId).catch(() => null);
    }

    if (msg) {
      await msg.edit({ embeds: [embed] });
    } else {
      msg = await findOrCreateMessage(channel, client);
      await msg.edit({ embeds: [embed] });
    }
  } catch (err) {
    log.error({ err }, 'Failed to update server status message');
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

  await findOrCreateMessage(channel, client);

  const intervalMs = config.serverStatus?.updateIntervalMs ?? 60000;
  updateInterval = setInterval(() => updateMessage(channel, client), intervalMs);
  log.info({ channelId, intervalMs }, 'Server status updater started');
}

export function stopStatusUpdater() {
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
    log.info('Server status updater stopped');
  }
}
