import { Events } from 'discord.js';
import { getOpenTicketByUser } from '../services/ticket/ticketService.js';
import { getOpenProspectByUser } from '../services/prospect/prospectService.js';
import * as ticketMessages from '../handlers/ticketMessages.js';
import * as prospectMessages from '../handlers/prospectMessages.js';

export default {
  name: Events.MessageCreate,

  async execute(message) {
    if (message.author.bot) return;

    if (!message.guild) {
      await handleDM(message);
    } else {
      await handleGuild(message);
    }
  },
};

async function handleDM(message) {
  const ticket = await getOpenTicketByUser(message.author.id);
  if (ticket) {
    return ticketMessages.handleDM(message, ticket);
  }

  const prospect = await getOpenProspectByUser(message.author.id);
  if (prospect) {
    if (!prospect.mentor_id) {
      return message.reply('**[Prospect]** Your application has been received. A mentor will contact you shortly — please wait for them to reach out.');
    }
    return prospectMessages.handleDM(message, prospect);
  }

  return message.reply('You don\'t have an open ticket or prospect application. Use the panels in the server to create one.');
}

async function handleGuild(message) {
  const handled = await ticketMessages.handleGuild(message);
  if (handled) return;

  await prospectMessages.handleGuild(message);
}
