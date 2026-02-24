import { randomUUID } from 'crypto';
import { ChannelType } from 'discord.js';
import { createEmbed } from '../../utils/embed.js';
import { buildPrivateChannelPermissions } from '../../utils/permissions.js';
import { findBotMessageByCustomId } from '../../utils/messageSearch.js';
import { buildTicketInfoEmbed, buildTicketComponents } from './ticketEmbeds.js';
import { query } from '../../database/connection.js';
import { getStoredSteamId } from '../userService.js';
import config from '../../config.js';
import logger from '../../logger.js';

const log = logger.child({ module: 'tickets' });

// ── DB Accessors ──

export async function getOpenTicketByUser(userId) {
  const rows = await query(
    'SELECT * FROM tickets WHERE user_id = ? AND status = ?',
    [userId, 'open']
  );
  return rows[0] || null;
}

export async function getTicketByChannel(channelId) {
  const rows = await query(
    'SELECT * FROM tickets WHERE channel_id = ? AND status = ?',
    [channelId, 'open']
  );
  return rows[0] || null;
}

export async function getClosedTicketsByUser(userId, tier) {
  return await query(
    'SELECT t.uuid, t.tier, t.created_at, (SELECT tm.content FROM ticket_messages tm WHERE tm.ticket_id = t.id AND tm.is_staff = 0 ORDER BY tm.id ASC LIMIT 1) AS first_message FROM tickets t WHERE t.user_id = ? AND t.status = ? AND t.tier = ? ORDER BY t.created_at DESC',
    [userId, 'closed', tier]
  );
}

export async function saveMessage(ticketId, authorId, authorTag, content, attachments, isStaff, sourceMessageId, channelMessageId) {
  await query(
    'INSERT INTO ticket_messages (ticket_id, author_id, author_tag, content, attachments, is_staff, source_message_id, channel_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [ticketId, authorId, authorTag, content, JSON.stringify(attachments || []), isStaff ? 1 : 0, sourceMessageId || null, channelMessageId || null]
  );
}

export async function getMessageBySourceId(sourceMessageId) {
  const rows = await query(
    'SELECT * FROM ticket_messages WHERE source_message_id = ?',
    [sourceMessageId]
  );
  return rows[0] || null;
}

// ── Operations ──

export async function createTicket(userId, guild, { steamId, reason } = {}) {
  const existing = await getOpenTicketByUser(userId);
  if (existing) return { error: 'You already have an open ticket.' };

  const uuid = randomUUID();
  const shortId = uuid.slice(0, 6);
  const { categoryId, roles } = config.tickets;

  const permissionOverwrites = buildPrivateChannelPermissions(guild, roles.normal);

  const channel = await guild.channels.create({
    name: `ticket-${shortId}`,
    type: ChannelType.GuildText,
    parent: categoryId || undefined,
    permissionOverwrites,
  });

  await query(
    'INSERT INTO tickets (uuid, channel_id, user_id) VALUES (?, ?, ?)',
    [uuid, channel.id, userId]
  );

  const rows = await query('SELECT * FROM tickets WHERE uuid = ?', [uuid]);
  const ticket = rows[0];

  await query(
    'INSERT INTO ticket_events (ticket_id, event_type, actor_id, detail) VALUES (?, ?, ?, ?)',
    [ticket.id, 'created', userId, null]
  );

  const member = await guild.members.fetch(userId).catch(() => null);
  const userTag = member?.user.tag || userId;

  const previousTickets = await getClosedTicketsByUser(userId, 'normal');
  const infoEmbed = buildTicketInfoEmbed(userTag, userId, uuid, 'normal', previousTickets.length, { steamId, reason });
  const components = buildTicketComponents('normal');

  await channel.send({ embeds: [infoEmbed], components });

  log.info({ uuid, userId, channelId: channel.id }, 'Ticket created');
  return { ticket, channel };
}

export async function escalateTicket(ticket, tier, channel, actorId = null) {
  if (ticket.tier !== 'normal') {
    return { error: 'This ticket has already been escalated.' };
  }

  const { roles } = config.tickets;

  const allRoles = new Set([...roles.normal, ...roles.communityOfficer, ...roles.adminOfficer]);
  const rolesToKeep = new Set(
    tier === 'community_officer' ? roles.communityOfficer : roles.adminOfficer
  );

  for (const roleId of allRoles) {
    if (rolesToKeep.has(roleId)) {
      log.debug({ roleId, action: 'allow' }, 'Escalation: keeping role with access');
      await channel.permissionOverwrites.edit(roleId, {
        ViewChannel: true,
        SendMessages: true,
      });
    } else {
      log.debug({ roleId, action: 'delete' }, 'Escalation: removing role access');
      await channel.permissionOverwrites.delete(roleId).catch((err) => {
        log.error({ err, roleId }, 'Failed to delete permission overwrite');
      });
    }
  }

  await query('UPDATE tickets SET tier = ? WHERE id = ?', [tier, ticket.id]);

  await query(
    'INSERT INTO ticket_events (ticket_id, event_type, actor_id, detail) VALUES (?, ?, ?, ?)',
    [ticket.id, 'escalated', actorId || channel.guild.members.me.id, tier]
  );

  const member = await channel.guild.members.fetch(ticket.user_id).catch(() => null);
  const userTag = member?.user.tag || ticket.user_id;

  const steamId = await getStoredSteamId(ticket.user_id);
  const previousTickets = await getClosedTicketsByUser(ticket.user_id, tier);
  const infoEmbed = buildTicketInfoEmbed(userTag, ticket.user_id, ticket.uuid, tier, previousTickets.length, { steamId });
  const components = buildTicketComponents(tier);

  const topMsg = await findBotMessageByCustomId(channel, channel.client.user.id, ['ticket_close', 'ticket_escalate_co']);
  if (topMsg) {
    await topMsg.edit({ embeds: [infoEmbed], components });
  }

  const tierLabel = tier === 'community_officer' ? 'Community Officer' : 'Admin Officer';
  const notifEmbed = createEmbed('Ticket')
    .setTitle('Ticket Escalated')
    .setDescription(`This ticket has been escalated to **${tierLabel}**.`)
    .setColor(tier === 'admin_officer' ? 0xed4245 : 0xfee75c);

  await channel.send({ embeds: [notifEmbed] });

  log.info({ ticketId: ticket.id, tier }, 'Ticket escalated');
  return {};
}

export async function closeTicket(ticket, closedById) {
  await query(
    'UPDATE tickets SET status = ?, closed_at = NOW(), closed_by = ? WHERE id = ?',
    ['closed', closedById, ticket.id]
  );

  await query(
    'INSERT INTO ticket_events (ticket_id, event_type, actor_id) VALUES (?, ?, ?)',
    [ticket.id, 'closed', closedById]
  );

  log.info({ ticketId: ticket.id, closedBy: closedById }, 'Ticket closed');
}
