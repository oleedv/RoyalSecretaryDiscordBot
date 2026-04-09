import { Events } from 'discord.js';
import { incrementReactionCount } from '../services/activity/activityService.js';

export default {
  name: Events.MessageReactionAdd,

  async execute(reaction, user) {
    if (reaction.partial) { try { reaction = await reaction.fetch(); } catch { return; } }
    if (user.partial) { try { user = await user.fetch(); } catch { return; } }
    if (user.bot) return;
    incrementReactionCount(user.id);
  },
};
