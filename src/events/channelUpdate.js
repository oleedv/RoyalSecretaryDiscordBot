import { Events } from 'discord.js';
import { isTrackedChannel, handleTempChannelRename } from '../services/tempvoice/tempvoiceManager.js';
import logger from '../logger.js';

const log = logger.child({ module: 'channel-update' });

export default {
  name: Events.ChannelUpdate,

  async execute(oldChannel, newChannel) {
    if (!newChannel?.id || !isTrackedChannel(newChannel.id)) return;
    // Only react to name changes (channelUpdate also fires for perms, bitrate, etc.).
    if (oldChannel?.name === newChannel.name) return;

    await handleTempChannelRename(oldChannel, newChannel).catch((err) => {
      log.error({ err, channelId: newChannel.id }, 'Failed to handle temp channel rename');
    });
  },
};
