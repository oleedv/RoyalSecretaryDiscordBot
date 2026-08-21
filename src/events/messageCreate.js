import { Events, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getOpenTicketByUser, getClosingTicketByUser, reopenTicket, rebuildTicketInfoEmbed } from '../services/ticket/ticketService.js';
import { getOpenProspectByUser, getProspectByUserWithChannel } from '../services/prospect/prospectService.js';
import { getStoredSteamId } from '../services/userService.js';
import * as ticketMessages from '../handlers/ticketMessages.js';
import * as prospectMessages from '../handlers/prospectMessages.js';
import * as prospectForumMessages from '../handlers/prospectForumMessages.js';
import { handleMessage as handleLayerRotationMessage } from '../services/layerRotationValidator/layerRotationChannelHandler.js';
import { infoEmbed, createEmbed, errorEmbed } from '../utils/embed.js';
import { logMessage } from '../services/admin/messageLogger.js';
import { incrementMessageCount } from '../services/activity/activityService.js';
import { reportError } from '../services/admin/errorAlertService.js';
import { logUnmatchedDm } from '../services/admin/dmLogService.js';
import { captureStaffMessage, resolveStaffTarget } from '../services/channelTranscript/channelTranscript.js';
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

    try {
      const handled = await handleLayerRotationMessage(message);
      if (handled) return;
    } catch (err) {
      reportError(err, {
        source: 'messageCreate.layerRotation',
        userId: message.author?.id,
        channelId: message.channel?.id,
      }).catch(() => {});
      return;
    }

    // Forum-thread capture runs BEFORE the bot-author short-circuit so bot intro/vote embeds are saved.
    if (
      message.guild &&
      message.channel.isThread?.() &&
      config.prospects?.forumChannelId &&
      message.channel.parentId === config.prospects.forumChannelId
    ) {
      try {
        await prospectForumMessages.handleForumThread(message);
      } catch (err) {
        reportError(err, {
          source: 'messageCreate.forumThread',
          userId: message.author?.id,
          channelId: message.channel?.id,
        }).catch(() => {});
      }
      logMessage(message);
      return;
    }

    // Staff ticket/prospect channels (and their Discord threads): capture bot
    // messages before the global bot short-circuit so info/steam/close embeds persist.
    if (message.guild) {
      try {
        const target = await resolveStaffTarget(message.channel);
        if (target && message.author.bot) {
          await captureStaffMessage(message, target);
          return;
        }
      } catch (err) {
        reportError(err, {
          source: 'messageCreate.staffTranscript',
          userId: message.author?.id,
          channelId: message.channel?.id,
        }).catch(() => {});
        if (message.author.bot) return;
      }
    }

    if (message.author.bot) return;

    logMessage(message);
    if (message.guild) incrementMessageCount(message.author.id, message.channel.id, message.channel.name);

    try {
      if (!message.guild) {
        await handleDM(message);
      } else {
        await handleGuild(message);
      }
    } catch (err) {
      reportError(err, {
        source: 'messageCreate',
        userId: message.author?.id,
        userTag: message.author?.tag,
        guildId: message.guild?.id,
        channelId: message.channel?.id,
      }).catch(() => {});
      if (!message.guild) {
        message.reply({ embeds: [errorEmbed('Something went wrong. Please try again later, or contact a server administrator if this keeps happening.')] }).catch(() => {});
      }
    }
  },
};

export async function handleDM(message) {
  log.debug({ userId: message.author.id }, 'handleDM: start');

  const ticket = await getOpenTicketByUser(message.author.id);
  if (ticket) {
    log.debug({ userId: message.author.id, ticketId: ticket.id }, 'handleDM: found open ticket');
    return ticketMessages.handleDM(message, ticket);
  }

  // Check for a ticket in the closing grace period - auto-reopen on user reply
  const closingTicket = await getClosingTicketByUser(message.author.id);
  if (closingTicket) {
    const reopenResult = await reopenTicket(closingTicket, message.author.id);
    if (reopenResult.error) {
      // A concurrent DM may have already won the reopen race. If the ticket is
      // now open, forward this message to it instead of dropping it.
      const reopenedTicket = await getOpenTicketByUser(message.author.id);
      if (reopenedTicket) {
        log.debug({ userId: message.author.id, ticketId: reopenedTicket.id }, 'handleDM: lost reopen race, forwarding to already-reopened ticket');
        return ticketMessages.handleDM(message, reopenedTicket);
      }
      log.warn({ userId: message.author.id, ticketId: closingTicket.id }, 'Ticket reopen failed and no open ticket found');
      await message.reply({ embeds: [infoEmbed('This ticket is no longer available. Please open a new ticket if you need help.')] }).catch(() => {});
      return;
    }

    const guild = await message.client.guilds.fetch(config.guild.id).catch(() => null);
    if (guild) {
      const channel = await guild.channels.fetch(closingTicket.channel_id).catch(() => null);
      if (channel) {
        await rebuildTicketInfoEmbed(closingTicket, channel, message.client);

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

  logUnmatchedDm(message).catch(() => {});

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
      .setStyle(ButtonStyle.Secondary),
  );

  const linkedSteamId = await getStoredSteamId(message.author.id);
  if (!linkedSteamId) {
    buttons.addComponents(
      new ButtonBuilder()
        .setCustomId('link_steam')
        .setLabel('Link Steam')
        .setStyle(ButtonStyle.Secondary),
    );
  }

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
  const target = await resolveStaffTarget(message.channel);
  if (!target) return;

  if (target.kind === 'ticket') {
    await ticketMessages.handleGuild(message, target.record);
    return;
  }

  await prospectMessages.handleGuild(message, target.record);
}
