import { Events, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getOpenTicketByUser, getClosingTicketByUser, reopenTicket, getClosedTicketsByUser } from '../services/ticket/ticketService.js';
import { buildTicketInfoEmbed, buildTicketComponents } from '../services/ticket/ticketEmbeds.js';
import { getStoredSteamId } from '../services/userService.js';
import { findBotMessageByCustomId } from '../utils/messageSearch.js';
import { getOpenProspectByUser, getProspectByUserWithChannel } from '../services/prospect/prospectService.js';
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

  // Check for a ticket in the closing grace period - auto-reopen on user reply
  const closingTicket = await getClosingTicketByUser(message.author.id);
  if (closingTicket) {
    await reopenTicket(closingTicket, message.author.id);

    const guild = await message.client.guilds.fetch(config.guild.id).catch(() => null);
    if (guild) {
      const channel = await guild.channels.fetch(closingTicket.channel_id).catch(() => null);
      if (channel) {
        // Clean up stale messages from the closing state
        const closedMsg = await findBotMessageByCustomId(channel, message.client.user.id, ['ticket_reopen']);
        if (closedMsg) await closedMsg.delete().catch(() => null);
        const oldInfoMsg = await findBotMessageByCustomId(channel, message.client.user.id, ['ticket_close']);
        if (oldInfoMsg) await oldInfoMsg.delete().catch(() => null);

        // Send fresh info embed with active buttons
        const member = await guild.members.fetch(closingTicket.user_id).catch(() => null);
        const userTag = member?.user.tag || closingTicket.user_id;
        const steamId = await getStoredSteamId(closingTicket.user_id);
        const previousTickets = await getClosedTicketsByUser(closingTicket.user_id, closingTicket.tier);
        const embed = buildTicketInfoEmbed(userTag, closingTicket.user_id, closingTicket.uuid, closingTicket.tier, previousTickets.length, { steamId, reason: closingTicket.reason });
        const components = buildTicketComponents(closingTicket.tier);
        await channel.send({ embeds: [embed], components });

        await channel.send({
          embeds: [infoEmbed(`<@${message.author.id}> replied and this ticket has been reopened.`)],
        });
      }
    }

    // Forward the DM message as if the ticket were open
    return ticketMessages.handleDM(message, { ...closingTicket, status: 'open' });
  }

  const prospect = await getOpenProspectByUser(message.author.id);
  if (prospect) {
    if (!prospect.mentor_id) {
      return message.reply({ embeds: [infoEmbed('Your application has been received. A mentor will contact you shortly - please wait for them to reach out.')] });
    }
    return prospectMessages.handleDM(message, prospect);
  }

  // Fallback: allow DM relay for recently-closed prospects whose channel still exists
  const closedProspect = await getProspectByUserWithChannel(message.author.id);
  if (closedProspect) {
    return prospectMessages.handleDM(message, closedProspect);
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

  const components = [buttons];

  // Add CO/Admin ticket buttons for members
  const guild = await message.client.guilds.fetch(config.guild.id).catch(() => null);
  if (guild) {
    const member = await guild.members.fetch(message.author.id).catch(() => null);
    const normalRoles = config.tickets?.roles?.normal || [];
    if (member && normalRoles.some((r) => member.roles.cache.has(r))) {
      const memberButtons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('ticket_create_co')
          .setLabel('CO Ticket')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('ticket_create_admin')
          .setLabel('Admin Ticket')
          .setStyle(ButtonStyle.Danger),
      );
      components.push(memberButtons);
    }
  }

  return message.reply({ embeds: [embed], components });
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
