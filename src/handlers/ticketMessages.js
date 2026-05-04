import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createEmbed, infoEmbed, errorEmbed } from '../utils/embed.js';
import { formatForDb, applyAttachments } from '../utils/attachments.js';
import { parseTextCommand } from '../utils/commands.js';
import { trySendWithFiles } from '../utils/discord.js';
import { getTicketByChannel, saveMessage, beginCloseGracePeriod, getClosedTicketsByUser, isAnonymousMode } from '../services/ticket/ticketService.js';
import { hasAnyRole } from '../utils/permissions.js';
import { detectSteamIds, buildSteamEmbed, buildVanityEmbed } from '../services/steamService.js';
import { resolvePlayerId } from '../services/battlemetricsService.js';
import config from '../config.js';
import logger from '../logger.js';

const fetchGuild = (client) => client.guilds.fetch(config.guild.id);

const log = logger.child({ module: 'ticketMessages' });

const allTicketStaffRoles = () => {
  const r = config.tickets.roles || {};
  return [...(r.normal || []), ...(r.communityOfficer || []), ...(r.adminOfficer || []), ...(r.compTeam || []), ...(r.whitelist || [])];
};

async function sendStaffReply(message, ticket, replyContent, anonymous) {
  if (!replyContent && message.attachments.size === 0) {
    await message.reply('Please provide a message to send.').then((m) => setTimeout(() => m.delete().catch(() => null), 5000));
    return;
  }

  const user = await message.client.users.fetch(ticket.user_id).catch(() => null);
  if (!user) {
    await message.reply('Could not find the ticket user.').then((m) => setTimeout(() => m.delete().catch(() => null), 5000));
    return;
  }

  const dmOptions = {};
  if (replyContent) {
    const senderName = anonymous ? 'Staff' : message.author.displayName;
    dmOptions.content = `**[Ticket]** **${senderName}**: ${replyContent}`;
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
    .setColor(anonymous ? 0x99aab5 : 0x5865f2);

  if (anonymous) {
    logEmbed.setFooter({ text: 'Royal Battalion \u25cf Ticket \u25cf Sent anonymously' });
  }

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

  log.debug({ ticketId: ticket.id, staffId: message.author.id, anonymous }, 'Staff reply sent');
}

export async function handleGuild(message) {
  const ticket = await getTicketByChannel(message.channel.id);
  if (!ticket) return false;

  const cmd = parseTextCommand(message.content);

  if (cmd?.type === 'close') {
    await message.delete().catch(() => null);
    const notice = await message.channel.send({
      content: `<@${message.author.id}> \`!close\` is disabled. Please use the **Close** button on the ticket info embed.`,
      allowedMentions: { users: [message.author.id] },
    }).catch(() => null);
    if (notice) setTimeout(() => notice.delete().catch(() => null), 10000);
    return true;
  }

  if (cmd?.type === 'logs') {
    const previous = await getClosedTicketsByUser(ticket.user_id, ticket.tier);
    if (previous.length === 0) {
      await message.channel.send('This user has no previous tickets.');
    } else {
      const page = Math.max(1, parseInt(cmd.content, 10) || 1);
      const { embed, components } = buildLogsPage(previous, page, ticket.user_id, ticket.tier);
      await message.channel.send({ embeds: [embed], components });
    }
    await message.delete().catch(() => null);
    return true;
  }

  if (cmd?.type === 'reply') {
    if (!hasAnyRole(message.member, allTicketStaffRoles())) return true;
    const anonymous = await isAnonymousMode(message.channel.id);
    await sendStaffReply(message, ticket, cmd.content, anonymous);
    return true;
  }

  if (cmd?.type === 'anonymous_reply') {
    if (!hasAnyRole(message.member, allTicketStaffRoles())) return true;
    await sendStaffReply(message, ticket, cmd.content, true);
    return true;
  }

  // SteamID detection on any message in a ticket channel
  const { steamIds, vanityUrls } = detectSteamIds(message.content.trim());
  for (const id of steamIds) {
    const bmPlayerId = await resolvePlayerId(id);
    await message.channel.send({ embeds: [buildSteamEmbed(id, bmPlayerId)] });
  }
  for (const vanity of vanityUrls) {
    await message.channel.send({ embeds: [buildVanityEmbed(vanity)] });
  }

  return true;
}

const LOGS_PAGE_SIZE = 10;
const TIER_SHORT = { normal: 'Normal', community_officer: 'Community', admin_officer: 'Admin', comp_team: 'Comp', whitelist: 'WL', legacy: 'Legacy' };

export function buildLogsPage(tickets, page, userId, tier) {
  const totalPages = Math.ceil(tickets.length / LOGS_PAGE_SIZE);
  const start = (page - 1) * LOGS_PAGE_SIZE;
  const pageItems = tickets.slice(start, start + LOGS_PAGE_SIZE);

  const lines = pageItems.map((t, i) => {
    const tierLabel = TIER_SHORT[t.tier] || t.tier;
    const preview = t.first_message
      ? t.first_message.slice(0, 50) + (t.first_message.length > 50 ? '..' : '')
      : '*no message*';
    const shortUuid = t.uuid.slice(0, 6);
    const ticketPath = t.tier === 'legacy' ? `/ticket/legacy/${t.uuid}` : `/ticket/${t.uuid}`;
    const uuidDisplay = config.webBaseUrl
      ? `[${new URL(config.webBaseUrl).host}/ticket/${shortUuid}](${config.webBaseUrl}${ticketPath})`
      : `\`${shortUuid}\``;
    return `${start + i + 1}. **${tierLabel}** - ${preview} - ${uuidDisplay}`;
  });

  const title = totalPages > 1
    ? `Previous Tickets (${tickets.length}) - Page ${page}/${totalPages}`
    : `Previous Tickets (${tickets.length})`;

  const embed = createEmbed('Ticket')
    .setTitle(title)
    .setDescription(lines.join('\n'))
    .setColor(0x5865f2);

  const components = [];
  if (totalPages > 1) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`logs_prev:${page - 1}:${userId}:${tier}`)
        .setLabel('Previous')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 1),
      new ButtonBuilder()
        .setCustomId(`logs_indicator`)
        .setLabel(`${page} / ${totalPages}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`logs_next:${page + 1}:${userId}:${tier}`)
        .setLabel('Next')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page >= totalPages),
    );
    components.push(row);
  }

  return { embed, components };
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
    const bmPlayerId = await resolvePlayerId(id);
    await channel.send({ embeds: [buildSteamEmbed(id, bmPlayerId)] });
  }
  for (const vanity of vanityUrls) {
    await channel.send({ embeds: [buildVanityEmbed(vanity)] });
  }

  const attachments = formatForDb(message.attachments);
  await saveMessage(ticket.id, message.author.id, message.author.tag, message.content, attachments, false, message.id, sent.id);
  if (!tooLarge) await message.react('✅').catch(() => null);

  log.debug({ ticketId: ticket.id, userId: message.author.id }, 'DM forwarded to ticket channel');
}
