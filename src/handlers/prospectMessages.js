import { createEmbed, infoEmbed, buildRelayEmbed } from '../utils/embed.js';
import { formatForDb, applyAttachments } from '../utils/attachments.js';
import { parseTextCommand } from '../utils/commands.js';
import { trySendWithFiles } from '../utils/discord.js';
import { getProspectByChannelAnyStatus, saveProspectMessage, closeProspect } from '../services/prospect/prospectService.js';
import config from '../config.js';
import logger from '../logger.js';

const fetchGuild = (client) => client.guilds.fetch(config.guild.id);

const log = logger.child({ module: 'prospectMessages' });

export async function handleGuild(message) {
  const prospect = await getProspectByChannelAnyStatus(message.channel.id);
  if (!prospect) return false;

  const cmd = parseTextCommand(message.content);

  if (cmd?.type === 'close') {
    if (prospect.status !== 'open') {
      await message.reply('This prospect is already closed. Use the Close Ticket button to delete the channel.').then((m) => setTimeout(() => m.delete().catch(() => null), 5000));
      return true;
    }
    await closeProspect(prospect, message.author.id, 'closed', message.guild);
    await message.channel.delete().catch(() => null);
    log.info({ prospectId: prospect.id, closedBy: message.author.id }, 'Prospect closed via !close');
    return true;
  }

  if (cmd?.type === 'reply') {
    const replyContent = cmd.content;

    if (!replyContent && message.attachments.size === 0) {
      await message.reply('Please provide a message to send.').then((m) => setTimeout(() => m.delete().catch(() => null), 5000));
      return true;
    }

    const user = await message.client.users.fetch(prospect.user_id).catch(() => null);
    if (!user) {
      await message.reply('Could not find the prospect user.').then((m) => setTimeout(() => m.delete().catch(() => null), 5000));
      return true;
    }

    const dmEmbed = buildRelayEmbed({
      type: 'Prospect',
      senderName: message.author.displayName,
      avatarUrl: message.author.displayAvatarURL(),
      content: replyContent,
    });
    const dmOptions = { embeds: [dmEmbed] };
    applyAttachments(dmEmbed, dmOptions, message.attachments);

    let dmFailed = false;
    let dmTooLarge = false;
    try {
      const { tooLarge } = await trySendWithFiles(user, dmOptions);
      dmTooLarge = tooLarge;
    } catch (err) {
      log.error({ err, userId: prospect.user_id }, 'Failed to DM prospect user');
      dmFailed = true;
    }

    const logEmbed = createEmbed('Prospect')
      .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() })
      .setDescription(replyContent || '*Attachment only*')
      .setColor(0x5865f2);

    const logOptions = { embeds: [logEmbed] };
    applyAttachments(logEmbed, logOptions, message.attachments);

    await trySendWithFiles(message.channel, logOptions);

    if (dmFailed) {
      await message.channel.send('Failed to send DM to the user. They may have DMs disabled.');
    } else if (dmTooLarge) {
      await message.channel.send('The file could not be re-attached to the user DM (too large or upload timed out). They received the text and a link to the attachment.');
    }
    await message.delete().catch(() => null);

    const attachments = formatForDb(message.attachments);
    await saveProspectMessage(prospect.id, message.author.id, message.author.tag, replyContent, attachments, true);

    log.debug({ prospectId: prospect.id, staffId: message.author.id }, 'Staff reply sent to prospect');
    return true;
  }

  return true;
}

export async function handleDM(message, prospect) {
  const guild = await fetchGuild(message.client);
  if (!guild) return;

  const channel = await guild.channels.fetch(prospect.channel_id).catch(() => null);
  if (!channel) {
    log.warn({ prospectId: prospect.id, channelId: prospect.channel_id }, 'Staff channel missing for prospect DM relay');
    return;
  }

  const embed = createEmbed('Prospect')
    .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() })
    .setDescription(message.content || '*No text content*')
    .setColor(0x57f287);

  const sendOptions = { embeds: [embed] };
  applyAttachments(embed, sendOptions, message.attachments);

  const { msg: sent, tooLarge } = await trySendWithFiles(channel, sendOptions);

  if (tooLarge) {
    await message.reply({ embeds: [infoEmbed('Your file could not be re-attached directly (too large or upload timed out). Staff can still access it via the link in the channel.')] }).catch(() => null);
  }

  const attachments = formatForDb(message.attachments);
  await saveProspectMessage(prospect.id, message.author.id, message.author.tag, message.content, attachments, false, message.id, sent.id);
  if (!tooLarge) await message.react('✅').catch(() => null);

  log.debug({ prospectId: prospect.id, userId: message.author.id }, 'DM forwarded to prospect channel');
}
