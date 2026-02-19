import { Events } from 'discord.js';
import { ensurePartialFetched } from '../utils/discord.js';
import { getProspectByVoteMessage, upsertVote } from '../services/prospect/prospectVoting.js';
import config from '../config.js';
import logger from '../logger.js';

const log = logger.child({ module: 'reactionAdd' });

export default {
  name: Events.MessageReactionAdd,

  async execute(reaction, user) {
    if (user.bot) return;

    if (!await ensurePartialFetched(reaction)) return;
    if (!await ensurePartialFetched(reaction.message)) return;

    const prospect = await getProspectByVoteMessage(reaction.message.id);
    if (!prospect) return;

    const { voteEmojis } = config.prospects;
    const emojiId = reaction.emoji.id;

    let voteType = null;
    if (emojiId === voteEmojis.yes) voteType = 'yes';
    else if (emojiId === voteEmojis.no) voteType = 'no';
    else if (emojiId === voteEmojis.unsure) voteType = 'unsure';

    if (!voteType) return;

    await upsertVote(prospect.id, user.id, user.tag, voteType);
    log.info({ prospectId: prospect.id, voterId: user.id, vote: voteType }, 'Vote recorded');
  },
};
