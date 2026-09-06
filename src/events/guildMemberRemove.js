import { Events } from 'discord.js';
import { getOpenTicketByUser, getClosingTicketByUser } from '../services/ticket/ticketService.js';
import { getOpenProspectByUser } from '../services/prospect/prospectService.js';
import { handleTicketMemberLeave, handleProspectMemberLeave, handleMentorLeave } from '../handlers/memberLeave.js';
import logger from '../logger.js';

const log = logger.child({ module: 'memberRemove' });

export default {
  name: Events.GuildMemberRemove,

  // Leaving the guild is not a deletion request. Membership, ticket, prospect,
  // whitelist, and moderation records are kept so staff can enforce bans, handle
  // appeals, and detect ban evasion. Data-subject requests go through Discord
  // as described in the public privacy policy.
  async execute(member) {
    const userId = member.id;
    const guild = member.guild;

    try {
      // Notify open tickets and tickets still in their closing grace period.
      const ticket = await getOpenTicketByUser(userId) || await getClosingTicketByUser(userId);
      if (ticket) await handleTicketMemberLeave(ticket, member, guild);

      const prospect = await getOpenProspectByUser(userId);
      if (prospect) await handleProspectMemberLeave(prospect, member, guild);

      await handleMentorLeave(userId, guild);
    } catch (err) {
      log.error({ err, userId }, 'Error handling member removal');
    }
  },
};
