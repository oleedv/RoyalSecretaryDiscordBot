import { Events } from 'discord.js';
import { incrementReactionCount } from '../services/activity/activityService.js';

export default {
  name: Events.MessageReactionAdd,

  execute(reaction, user) {
    if (user.partial || user.bot) return;
    incrementReactionCount(user.id);
  },
};
