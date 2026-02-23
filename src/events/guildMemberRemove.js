import { Events } from 'discord.js';
import { getOpenTicketByUser } from '../services/ticket/ticketService.js';
import { getOpenProspectByUser } from '../services/prospect/prospectService.js';
import { handleTicketMemberLeave, handleProspectMemberLeave, handleMentorLeave } from '../handlers/memberLeave.js';
import logger from '../logger.js';

const log = logger.child({ module: 'memberRemove' });

export default {
  name: Events.GuildMemberRemove,

  async execute(member) {
    const userId = member.id;
    const guild = member.guild;

    try {
      const ticket = await getOpenTicketByUser(userId);
      if (ticket) await handleTicketMemberLeave(ticket, member, guild);

      const prospect = await getOpenProspectByUser(userId);
      if (prospect) await handleProspectMemberLeave(prospect, member, guild);

      await handleMentorLeave(userId, guild);
    } catch (err) {
      log.error({ err, userId }, 'Error handling member removal');
    }
  },
};
