import { Events } from 'discord.js';
import { handleVoiceStateUpdate } from '../services/activity/voiceTracker.js';
import { handleTempVoiceStateUpdate } from '../services/tempvoice/tempvoiceManager.js';

export default {
  name: Events.VoiceStateUpdate,

  execute(oldState, newState) {
    handleVoiceStateUpdate(oldState, newState);
    handleTempVoiceStateUpdate(oldState, newState).catch(() => null);
  },
};
