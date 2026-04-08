import { Events } from 'discord.js';
import { handleVoiceStateUpdate } from '../services/activity/voiceTracker.js';

export default {
  name: Events.VoiceStateUpdate,

  execute(oldState, newState) {
    handleVoiceStateUpdate(oldState, newState);
  },
};
