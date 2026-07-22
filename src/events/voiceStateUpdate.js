import { Events } from 'discord.js';
import { handleVoiceStateUpdate } from '../services/activity/voiceTracker.js';
import { handleTempVoiceStateUpdate } from '../services/tempvoice/tempvoiceManager.js';
import logger from '../logger.js';

const log = logger.child({ module: 'voice-state-update' });

export default {
  name: Events.VoiceStateUpdate,

  execute(oldState, newState) {
    handleVoiceStateUpdate(oldState, newState);
    handleTempVoiceStateUpdate(oldState, newState).catch((err) => {
      log.error({ err, userId: newState.id, oldChannelId: oldState.channelId, newChannelId: newState.channelId }, 'Temp voice state update failed');
    });
  },
};
