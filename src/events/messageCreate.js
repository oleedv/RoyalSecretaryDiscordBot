import { Events, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getOpenTicketByUser } from '../services/ticket/ticketService.js';
import { getOpenProspectByUser } from '../services/prospect/prospectService.js';
import * as ticketMessages from '../handlers/ticketMessages.js';
import * as prospectMessages from '../handlers/prospectMessages.js';
import { infoEmbed, createEmbed } from '../utils/embed.js';
import { logMessage } from '../services/admin/messageLogger.js';
import config from '../config.js';
import logger from '../logger.js';

const log = logger.child({ module: 'messageCreate' });

export default {
  name: Events.MessageCreate,

  async execute(message) {
    if (message.author.bot) return;

    logMessage(message);

    try {
      if (!message.guild) {
        await handleDM(message);
      } else {
        await handleGuild(message);
      }
    } catch (err) {
      log.error({ err, userId: message.author.id, channelId: message.channel.id }, 'Error handling message');
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
      return message.reply({ embeds: [infoEmbed('Your application has been received. A mentor will contact you shortly — please wait for them to reach out.')] });
    }
    return prospectMessages.handleDM(message, prospect);
  }

  const embed = createEmbed()
    .setTitle('Royal Battalion')
    .setDescription(
      'Welcome! How can we help you today?\n\n' +
      'Use the buttons below to get started. Create a ticket for support requests, player reports, or any questions.'
    );

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_create')
      .setLabel('Create Ticket')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('prospect_apply')
      .setLabel('Join RB')
      .setStyle(ButtonStyle.Success),
  );

  const infoChannelId = config.dm?.infoChannelId;
  if (infoChannelId) {
    buttons.addComponents(
      new ButtonBuilder()
        .setLabel('Server Info')
        .setStyle(ButtonStyle.Link)
        .setURL(`https://discord.com/channels/${config.guild.id}/${infoChannelId}`),
    );
  }

  return message.reply({ embeds: [embed], components: [buttons] });
}

async function handleGuild(message) {
  const parentId = message.channel.parentId;
  if (!parentId) return;

  const relevantCategories = [config.ticket?.categoryId, config.prospect?.categoryId].filter(Boolean);
  if (relevantCategories.length > 0 && !relevantCategories.includes(parentId)) return;

  const handled = await ticketMessages.handleGuild(message);
  if (handled) return;

  await prospectMessages.handleGuild(message);
}
