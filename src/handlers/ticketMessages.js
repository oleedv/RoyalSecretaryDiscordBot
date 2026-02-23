import { createEmbed, infoEmbed } from '../utils/embed.js';
import { formatForDb, applyAttachments } from '../utils/attachments.js';
import { parseTextCommand } from '../utils/commands.js';
import { trySendWithFiles } from '../utils/discord.js';
import { getTicketByChannel, saveMessage, closeTicket, getClosedTicketsByUser } from '../services/ticket/ticketService.js';
import { detectSteamIds, buildSteamEmbed, buildVanityEmbed } from '../services/steamService.js';
import config from '../config.js';
import logger from '../logger.js';

const fetchGuild = (client) => client.guilds.fetch(config.guild.id);

const log = logger.child({ module: 'ticketMessages' });

export async function handleGuild(message) {
  const ticket = await getTicketByChannel(message.channel.id);
  if (!ticket) return false;

  const cmd = parseTextCommand(message.content);

  if (cmd?.type === 'close') {
    await closeTicket(ticket, message.author.id);

    const user = await message.client.users.fetch(ticket.user_id).catch(() => null);
    if (user) {
      await user.send({ embeds: [infoEmbed('Your ticket has been closed. Thank you!')] }).catch(() => null);
    }

    await message.channel.delete().catch(() => null);
    log.info({ ticketId: ticket.id, closedBy: message.author.id }, 'Ticket closed via !close');
    return true;
  }

  if (cmd?.type === 'logs') {
    const previous = await getClosedTicketsByUser(ticket.user_id);
    if (previous.length === 0) {
      await message.channel.send('This user has no previous tickets.');
    } else {
      const TIER_SHORT = { normal: 'Normal', community_officer: 'Community', admin_officer: 'Admin' };
      const allLines = previous.map((t, i) => {
        const tier = TIER_SHORT[t.tier] || t.tier;
        const preview = t.first_message
          ? t.first_message.slice(0, 10) + (t.first_message.length > 10 ? '..' : '')
          : '*no message*';
        const uuidDisplay = config.webBaseUrl
          ? `[${t.uuid}](${config.webBaseUrl}/ticket/${t.uuid})`
          : `\`${t.uuid}\``;
        return `${i + 1}. **${tier}** - ${preview} - ${uuidDisplay}`;
      });

      const pages = [];
      let current = [];
      let currentLen = 0;
      for (const line of allLines) {
        if (currentLen + line.length + 1 > 3900 && current.length > 0) {
          pages.push(current);
          current = [];
          currentLen = 0;
        }
        current.push(line);
        currentLen += line.length + 1;
      }
      if (current.length > 0) pages.push(current);

      const pageNum = parseInt(cmd.content || '1', 10) || 1;
      const page = pages[pageNum - 1];

      if (!page) {
        await message.channel.send(`No page ${pageNum}. There ${pages.length === 1 ? 'is' : 'are'} only ${pages.length} page${pages.length === 1 ? '' : 's'}.`);
      } else {
        const title = pages.length > 1
          ? `Previous Tickets (${previous.length}) — Page ${pageNum}/${pages.length}`
          : `Previous Tickets (${previous.length})`;

        const embed = createEmbed('Ticket')
          .setTitle(title)
          .setDescription(page.join('\n'))
          .setColor(0x5865f2);

        if (pageNum < pages.length) {
          embed.addFields({ name: 'More', value: `Use \`!logs${pageNum + 1}\` to see the next page.` });
        }

        await message.channel.send({ embeds: [embed] });
      }
    }
    await message.delete().catch(() => null);
    return true;
  }

  if (cmd?.type === 'reply') {
    const replyContent = cmd.content;

    if (!replyContent && message.attachments.size === 0) {
      await message.reply('Please provide a message to send.').then((m) => setTimeout(() => m.delete().catch(() => null), 5000));
      return true;
    }

    const user = await message.client.users.fetch(ticket.user_id).catch(() => null);
    if (!user) {
      await message.reply('Could not find the ticket user.').then((m) => setTimeout(() => m.delete().catch(() => null), 5000));
      return true;
    }

    const dmOptions = {};
    if (replyContent) {
      dmOptions.content = `**[Ticket]** **${message.author.displayName}**: ${replyContent}`;
    }
    if (message.attachments.size > 0) {
      dmOptions.files = message.attachments.map((a) => ({ attachment: a.url, name: a.name }));
    }

    let dmFailed = false;
    let dmTooLarge = false;
    try {
      const { tooLarge } = await trySendWithFiles(user, dmOptions);
      dmTooLarge = tooLarge;
    } catch (err) {
      log.error({ err, userId: ticket.user_id }, 'Failed to DM ticket user');
      dmFailed = true;
    }

    const logEmbed = createEmbed('Ticket')
      .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() })
      .setDescription(replyContent || '*Attachment only*')
      .setColor(0x5865f2);

    const logOptions = { embeds: [logEmbed] };
    applyAttachments(logEmbed, logOptions, message.attachments);

    await trySendWithFiles(message.channel, logOptions);

    if (dmFailed) {
      await message.channel.send('Failed to send DM to the user. They may have DMs disabled.');
    } else if (dmTooLarge) {
      await message.channel.send('The file was too large to send to the user. They received the text but the attachment was sent as a link only.');
    }
    await message.delete().catch(() => null);

    const attachments = formatForDb(message.attachments);
    await saveMessage(ticket.id, message.author.id, message.author.tag, replyContent, attachments, true);

    log.debug({ ticketId: ticket.id, staffId: message.author.id }, 'Staff reply sent');
    return true;
  }

  // SteamID detection on any message in a ticket channel
  const { steamIds, vanityUrls } = detectSteamIds(message.content.trim());
  for (const id of steamIds) {
    await message.channel.send({ embeds: [buildSteamEmbed(id)] });
  }
  for (const vanity of vanityUrls) {
    await message.channel.send({ embeds: [buildVanityEmbed(vanity)] });
  }

  return true;
}

export async function handleDM(message, ticket) {
  const guild = await fetchGuild(message.client);
  if (!guild) return;

  const channel = await guild.channels.fetch(ticket.channel_id).catch(() => null);
  if (!channel) return;

  const embed = createEmbed('Ticket')
    .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() })
    .setDescription(message.content || '*No text content*')
    .setColor(0x57f287);

  const sendOptions = { embeds: [embed] };
  applyAttachments(embed, sendOptions, message.attachments);

  const { msg: sent, tooLarge } = await trySendWithFiles(channel, sendOptions);

  if (tooLarge) {
    await message.reply('Your file was too large to embed directly. Staff can still access it via the link.').catch(() => null);
  }

  const { steamIds, vanityUrls } = detectSteamIds(message.content || '');
  for (const id of steamIds) {
    await channel.send({ embeds: [buildSteamEmbed(id)] });
  }
  for (const vanity of vanityUrls) {
    await channel.send({ embeds: [buildVanityEmbed(vanity)] });
  }

  const attachments = formatForDb(message.attachments);
  await saveMessage(ticket.id, message.author.id, message.author.tag, message.content, attachments, false, message.id, sent.id);
  if (!tooLarge) await message.react('✅').catch(() => null);

  log.debug({ ticketId: ticket.id, userId: message.author.id }, 'DM forwarded to ticket channel');
}
