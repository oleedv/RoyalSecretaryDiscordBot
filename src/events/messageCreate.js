import { Events, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getOpenTicketByUser, getClosingTicketByUser, reopenTicket, getClosedTicketsByUser } from '../services/ticket/ticketService.js';
import { buildTicketInfoEmbed, buildTicketComponents } from '../services/ticket/ticketEmbeds.js';
import { getStoredSteamId } from '../services/userService.js';
import { findBotMessageByCustomId } from '../utils/messageSearch.js';
import { getOpenProspectByUser, getProspectByUserWithChannel } from '../services/prospect/prospectService.js';
import * as ticketMessages from '../handlers/ticketMessages.js';
import * as prospectMessages from '../handlers/prospectMessages.js';
import { infoEmbed, createEmbed, errorEmbed } from '../utils/embed.js';
import { logMessage } from '../services/admin/messageLogger.js';
import config from '../config.js';
import logger from '../logger.js';

const log = logger.child({ module: 'messageCreate' });

export default {
  name: Events.MessageCreate,

  async execute(message) {
    if (message.partial) {
      try { message = await message.fetch(); } catch (err) {
        log.error({ err }, 'messageCreate: failed to fetch partial');
        return;
      }
    }
    if (message.author.bot) return;

    logMessage(message);

    try {
      if (!message.guild) {
        await handleDM(message);
      } else {
        await handleGuild(message);
      }
    } catch (err) {
      log.error({ err, userId: message.author?.id, channelId: message.channel?.id }, 'Error handling message');
      if (!message.guild) {
        message.reply({ embeds: [errorEmbed('Something went wrong. Please try again later, or contact <@195412349153312768> Ole if this keeps happening.')] }).catch(() => {});
      }
    }
  },
};

async function handleDM(message) {
  log.debug({ userId: message.author.id }, 'handleDM: start');

  const ticket = await getOpenTicketByUser(message.author.id);
  if (ticket) {
    log.debug({ userId: message.author.id, ticketId: ticket.id }, 'handleDM: found open ticket');
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

  log.debug({ userId: message.author.id }, 'handleDM: no open/closing ticket');

  const prospect = await getOpenProspectByUser(message.author.id);
  if (prospect) {
    if (!prospect.mentor_id) {
      return message.reply({ embeds: [infoEmbed('Your application has been received. A mentor will contact you shortly - please wait for them to reach out.')] });
    }
    return prospectMessages.handleDM(message, prospect);
  }

  log.debug({ userId: message.author.id }, 'handleDM: no open prospect');

  // Fallback: allow DM relay for recently-closed prospects whose channel still exists
  const closedProspect = await getProspectByUserWithChannel(message.author.id);
  if (closedProspect) {
    const guild = await message.client.guilds.fetch(config.guild.id).catch(() => null);
    const prospectChannel = guild ? await guild.channels.fetch(closedProspect.channel_id).catch(() => null) : null;
    if (prospectChannel) {
      return prospectMessages.handleDM(message, closedProspect);
    }
  }

  log.debug({ userId: message.author.id }, 'handleDM: sending welcome menu');

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
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
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
