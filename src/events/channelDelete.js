import { Events } from 'discord.js';
import { isTrackedChannel, handleManualChannelDelete } from '../services/tempvoice/tempvoiceManager.js';
import logger from '../logger.js';

const log = logger.child({ module: 'channel-delete' });

export default {
  name: Events.ChannelDelete,

  async execute(channel) {
    if (!isTrackedChannel(channel.id)) return;

    log.info({ channelId: channel.id, channelName: channel.name }, 'Tracked temp channel deleted externally');
    await handleManualChannelDelete(channel.id, channel.guild).catch((err) => {
      log.error({ err, channelId: channel.id }, 'Failed to handle manual channel deletion');
    });
  },
};
