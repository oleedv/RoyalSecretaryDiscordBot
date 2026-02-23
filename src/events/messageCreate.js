import { Events, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getOpenTicketByUser } from '../services/ticket/ticketService.js';
import { getOpenProspectByUser } from '../services/prospect/prospectService.js';
import * as ticketMessages from '../handlers/ticketMessages.js';
import * as prospectMessages from '../handlers/prospectMessages.js';
import { infoEmbed, createEmbed } from '../utils/embed.js';
import config from '../config.js';

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
  const handled = await ticketMessages.handleGuild(message);
  if (handled) return;

  await prospectMessages.handleGuild(message);
}
