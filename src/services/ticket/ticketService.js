import { randomUUID } from 'crypto';
import { ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createEmbed, infoEmbed } from '../../utils/embed.js';
import { buildPrivateChannelPermissions } from '../../utils/permissions.js';
import { findBotMessageByCustomId } from '../../utils/messageSearch.js';
import { buildTicketInfoEmbed, buildTicketComponents } from './ticketEmbeds.js';
import { query } from '../../database/connection.js';
import { getStoredSteamId } from '../userService.js';
import config from '../../config.js';
import logger from '../../logger.js';

const log = logger.child({ module: 'tickets' });

const GRACE_PERIOD_MS = 60 * 60 * 1000; // 1 hour

// In-memory timer store for closing grace periods (channelId → timeout ref)
const closingTimers = new Map();

async function deleteLogsEmbeds(channel, botId) {
  const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (!messages) return;
  for (const msg of messages.values()) {
    if (msg.author.id !== botId) continue;
    const isLogsEmbed = msg.embeds.some((e) => e.title?.startsWith('Previous Tickets'));
    if (isLogsEmbed) await msg.delete().catch(() => null);
  }
}

// ── DB Accessors ──

export async function getOpenTicketByUser(userId) {
  const rows = await query(
    'SELECT * FROM tickets WHERE user_id = ? AND status = ?',
    [userId, 'open']
  );
  return rows[0] || null;
}

export async function getClosingTicketByUser(userId) {
  const rows = await query(
    'SELECT * FROM tickets WHERE user_id = ? AND status = ?',
    [userId, 'closing']
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

export async function getTicketByChannelStatus(channelId, status) {
  const rows = await query(
    'SELECT * FROM tickets WHERE channel_id = ? AND status = ?',
    [channelId, status]
  );
  return rows[0] || null;
}

export async function getClosedTicketsByUser(userId, tier) {
  if (tier === 'normal') {
    return await query(
      'SELECT t.uuid, t.tier, t.created_at, (SELECT tm.content FROM ticket_messages tm WHERE tm.ticket_id = t.id AND tm.is_staff = 0 ORDER BY tm.id ASC LIMIT 1) AS first_message FROM tickets t WHERE t.user_id = ? AND t.status = ? AND t.tier = ? ORDER BY t.created_at DESC',
      [userId, 'closed', tier]
    );
  }
  return await query(
    'SELECT t.uuid, t.tier, t.created_at, (SELECT tm.content FROM ticket_messages tm WHERE tm.ticket_id = t.id AND tm.is_staff = 0 ORDER BY tm.id ASC LIMIT 1) AS first_message FROM tickets t WHERE t.user_id = ? AND t.status = ? AND t.tier IN (?, ?) ORDER BY t.created_at DESC',
    [userId, 'closed', tier, 'normal']
  );
}

export async function getAllClosedTicketsByUser(userId) {
  return await query(
    'SELECT t.uuid, t.tier, t.created_at, (SELECT tm.content FROM ticket_messages tm WHERE tm.ticket_id = t.id AND tm.is_staff = 0 ORDER BY tm.id ASC LIMIT 1) AS first_message FROM tickets t WHERE t.user_id = ? AND t.status = ? ORDER BY t.created_at DESC',
    [userId, 'closed']
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

// ── Timeout Accessors ──

export async function getActiveTimeout(userId) {
  const rows = await query(
    'SELECT * FROM ticket_timeouts WHERE user_id = ? AND expires_at > NOW()',
    [userId]
  );
  return rows[0] || null;
}

export async function timeoutUser(userId, timedOutById) {
  const existing = await getActiveTimeout(userId);
  if (existing) return { error: 'This user is already timed out from creating tickets.' };

  await query(
    'INSERT INTO ticket_timeouts (user_id, timed_out_by, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 DAY))',
    [userId, timedOutById]
  );

  log.info({ userId, timedOutById }, 'User timed out from creating tickets');
  return {};
}

// ── Operations ──

const activeCreations = new Set();

export async function createTicket(userId, guild, { steamId, reason, tier = 'normal' } = {}) {
  if (activeCreations.has(userId)) return { error: 'Ticket creation already in progress.' };
  activeCreations.add(userId);
  try {
    return await _createTicket(userId, guild, { steamId, reason, tier });
  } finally {
    activeCreations.delete(userId);
  }
}

const tierConfigKey = {
  normal: 'normal',
  community_officer: 'communityOfficer',
  admin_officer: 'adminOfficer',
  comp_team: 'compTeam',
  whitelist: 'whitelist',
};

async function _createTicket(userId, guild, { steamId, reason, tier = 'normal' } = {}) {
  const existing = await getOpenTicketByUser(userId);
  if (existing) return { error: 'You already have an open ticket.' };

  const closing = await getClosingTicketByUser(userId);
  if (closing) return { error: 'You have a ticket that was recently closed. Please reply to your DMs to reopen it, or wait for it to fully close.' };

  const timeout = await getActiveTimeout(userId);
  if (timeout) {
    const expiresAt = new Date(timeout.expires_at);
    const timeLeft = Math.ceil((expiresAt - Date.now()) / (1000 * 60 * 60));
    return { error: `You are temporarily unable to create tickets. Try again in approximately ${timeLeft} hour${timeLeft === 1 ? '' : 's'}.` };
  }

  const uuid = randomUUID();
  const shortId = uuid.slice(0, 6);
  const { categoryId, roles } = config.tickets;

  const configKey = tierConfigKey[tier] || 'normal';
  const tierRoles = roles[configKey] || roles.normal;
  const permissionOverwrites = buildPrivateChannelPermissions(guild, tierRoles);

  const channel = await guild.channels.create({
    name: `ticket-${shortId}`,
    type: ChannelType.GuildText,
    parent: categoryId || undefined,
    permissionOverwrites,
  });

  await query(
    'INSERT INTO tickets (uuid, channel_id, user_id, reason, tier) VALUES (?, ?, ?, ?, ?)',
    [uuid, channel.id, userId, reason || null, tier]
  );

  const rows = await query('SELECT * FROM tickets WHERE uuid = ?', [uuid]);
  const ticket = rows[0];

  await query(
    'INSERT INTO ticket_events (ticket_id, event_type, actor_id, detail) VALUES (?, ?, ?, ?)',
    [ticket.id, 'created', userId, null]
  );

  const member = await guild.members.fetch(userId).catch(() => null);
  const userTag = member?.user.tag || userId;

  const previousTickets = await getClosedTicketsByUser(userId, tier);
  const embed = buildTicketInfoEmbed(userTag, userId, uuid, tier, previousTickets.length, { steamId, reason });
  const components = buildTicketComponents(tier);

  await channel.send({ embeds: [embed], components });

  // Ping staff roles so they get a notification
  const staffPing = tierRoles.map((r) => `<@&${r}>`).join(' ');
  await channel.send({ content: staffPing, allowedMentions: { roles: tierRoles } }).then((m) => m.delete().catch(() => null));

  log.info({ uuid, userId, channelId: channel.id, tier }, 'Ticket created');
  return { ticket, channel };
}

export async function escalateTicket(ticket, tier, channel, actorId = null) {
  if (ticket.tier === tier) {
    return { error: 'This ticket is already assigned to that team.' };
  }

  const { roles } = config.tickets;

  const allRoles = new Set([...roles.normal, ...roles.communityOfficer, ...roles.adminOfficer, ...roles.compTeam, ...roles.whitelist]);
  const tierRoleMap = {
    normal: roles.normal,
    community_officer: roles.communityOfficer,
    admin_officer: roles.adminOfficer,
    comp_team: roles.compTeam,
    whitelist: roles.whitelist,
  };
  const rolesToKeep = new Set(tierRoleMap[tier]);

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
  const infoEmbed = buildTicketInfoEmbed(userTag, ticket.user_id, ticket.uuid, tier, previousTickets.length, { steamId, reason: ticket.reason });
  const components = buildTicketComponents(tier);

  const topMsg = await findBotMessageByCustomId(channel, channel.client.user.id, ['ticket_close', 'ticket_escalate_co', 'ticket_escalate_admin', 'ticket_escalate_comp', 'ticket_escalate_wl', 'ticket_escalate_normal']);
  if (topMsg) {
    await topMsg.edit({ embeds: [infoEmbed], components });
  }

  const tierLabels = {
    normal: 'Normal',
    community_officer: 'Community Officer',
    admin_officer: 'Admin Officer',
    comp_team: 'Comp Team',
    whitelist: 'Whitelist',
  };
  const tierColors = {
    normal: 0x5865f2,
    community_officer: 0xfee75c,
    admin_officer: 0xed4245,
    comp_team: 0x57f287,
    whitelist: 0x3498db,
  };
  // Remove any !logs embeds from the previous team
  await deleteLogsEmbeds(channel, channel.client.user.id);

  const tierLabel = tierLabels[tier] || tier;
  const notifEmbed = createEmbed('Ticket')
    .setTitle('Ticket Transferred')
    .setDescription(`This ticket has been transferred to **${tierLabel}**.\n\nFrom this point forward, this conversation is confidential and only visible to the **${tierLabel}** team.`)
    .setColor(tierColors[tier] || 0x5865f2);

  await channel.send({ embeds: [notifEmbed] });

  // Ping the escalation target roles so they get a notification
  const targetRoles = tierRoleMap[tier];
  const escalatePing = targetRoles.map((r) => `<@&${r}>`).join(' ');
  await channel.send({ content: escalatePing, allowedMentions: { roles: targetRoles } }).then((m) => m.delete().catch(() => null));

  log.info({ ticketId: ticket.id, tier }, 'Ticket escalated');
  return {};
}

export async function beginCloseGracePeriod(ticket, closedById, channel, client) {
  await query(
    'UPDATE tickets SET status = ?, closed_at = NOW(), closed_by = ? WHERE id = ?',
    ['closing', closedById, ticket.id]
  );

  await query(
    'INSERT INTO ticket_events (ticket_id, event_type, actor_id) VALUES (?, ?, ?)',
    [ticket.id, 'closed', closedById]
  );

  // Disable existing buttons on the info embed
  const topMsg = await findBotMessageByCustomId(channel, client.user.id, ['ticket_close', 'ticket_escalate_normal', 'ticket_escalate_co', 'ticket_escalate_admin', 'ticket_escalate_comp', 'ticket_escalate_wl']);
  if (topMsg) {
    const disabledComponents = topMsg.components.map((row) => {
      const newRow = ActionRowBuilder.from(row);
      newRow.components = row.components.map((btn) =>
        ButtonBuilder.from(btn).setDisabled(true)
      );
      return newRow;
    });
    await topMsg.edit({ components: disabledComponents }).catch(() => null);
  }

  // Remove any !logs embeds before closing
  await deleteLogsEmbeds(channel, client.user.id);

  // Send closing embed with Reopen + Force Close buttons
  const deleteAt = Math.floor((Date.now() + GRACE_PERIOD_MS) / 1000);
  const closedEmbed = createEmbed('Ticket')
    .setTitle('Ticket Closed')
    .setDescription(`This ticket has been closed. The channel will be deleted <t:${deleteAt}:R>.\n\nStaff can reopen it or force close it with the buttons below. The user can also reply via DM to reopen.`)
    .setColor(0x99aab5);

  const reopenRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_reopen')
      .setLabel('Reopen Ticket')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('ticket_force_close')
      .setLabel('Force Close')
      .setStyle(ButtonStyle.Danger)
  );

  await channel.send({ embeds: [closedEmbed], components: [reopenRow] });

  // DM the user
  const user = await client.users.fetch(ticket.user_id).catch(() => null);
  if (user) {
    await user.send({
      embeds: [infoEmbed('Your ticket has been closed. If you need to add anything, reply here within the next hour and your ticket will be reopened automatically.')],
    }).catch(() => null);
  }

  // Schedule channel deletion after grace period
  const timer = setTimeout(async () => {
    closingTimers.delete(channel.id);
    await query(
      'UPDATE tickets SET status = ? WHERE id = ?',
      ['closed', ticket.id]
    );
    await channel.delete().catch(() => null);
    log.info({ ticketId: ticket.id }, 'Ticket channel deleted after grace period');
  }, GRACE_PERIOD_MS);

  closingTimers.set(channel.id, timer);
  log.info({ ticketId: ticket.id, channelId: channel.id, closedBy: closedById }, 'Ticket closing grace period started');
}

export async function forceCloseTicket(ticket, channel) {
  const timer = closingTimers.get(ticket.channel_id);
  if (timer) {
    clearTimeout(timer);
    closingTimers.delete(ticket.channel_id);
  }

  await query(
    'UPDATE tickets SET status = ? WHERE id = ?',
    ['closed', ticket.id]
  );

  // DM the user that their ticket has been permanently closed
  const user = await channel.guild.members.fetch(ticket.user_id).then((m) => m.user).catch(() => null);
  if (user) {
    await user.send({
      embeds: [infoEmbed('Your ticket has been closed and can no longer be reopened. If you need further help, please open a new ticket.')],
    }).catch(() => null);
  }

  await channel.delete().catch(() => null);
  log.info({ ticketId: ticket.id }, 'Ticket force closed');
}

export async function reopenTicket(ticket, reopenedById) {
  const timer = closingTimers.get(ticket.channel_id);
  if (timer) {
    clearTimeout(timer);
    closingTimers.delete(ticket.channel_id);
  }

  await query(
    'UPDATE tickets SET status = ?, closed_at = NULL, closed_by = NULL WHERE id = ?',
    ['open', ticket.id]
  );

  await query(
    'INSERT INTO ticket_events (ticket_id, event_type, actor_id) VALUES (?, ?, ?)',
    [ticket.id, 'reopened', reopenedById]
  );

  log.info({ ticketId: ticket.id, reopenedBy: reopenedById }, 'Ticket reopened');
}

/**
 * Resume grace period timers for tickets stuck in 'closing' status after a bot restart.
 * Call this from the ready event handler.
 */
export async function resumeClosingTimers(client) {
  const rows = await query('SELECT * FROM tickets WHERE status = ?', ['closing']);
  if (rows.length === 0) return;

  const guild = await client.guilds.fetch(config.guild.id).catch(() => null);
  if (!guild) return;

  for (const ticket of rows) {
    const channel = await guild.channels.fetch(ticket.channel_id).catch(() => null);
    if (!channel) {
      // Channel already gone - finalize as closed
      await query('UPDATE tickets SET status = ? WHERE id = ?', ['closed', ticket.id]);
      log.info({ ticketId: ticket.id }, 'Orphaned closing ticket finalized as closed');
      continue;
    }

    // Calculate remaining time (closed_at + 1 hour - now)
    const closedAt = new Date(ticket.closed_at).getTime();
    const remaining = (closedAt + GRACE_PERIOD_MS) - Date.now();

    if (remaining <= 0) {
      // Grace period already expired
      await query('UPDATE tickets SET status = ? WHERE id = ?', ['closed', ticket.id]);
      await channel.delete().catch(() => null);
      log.info({ ticketId: ticket.id }, 'Expired closing ticket finalized on restart');
      continue;
    }

    // Schedule deletion for remaining time
    const timer = setTimeout(async () => {
      closingTimers.delete(channel.id);
      await query('UPDATE tickets SET status = ? WHERE id = ?', ['closed', ticket.id]);
      await channel.delete().catch(() => null);
      log.info({ ticketId: ticket.id }, 'Ticket channel deleted after resumed grace period');
    }, remaining);

    closingTimers.set(channel.id, timer);
    log.info({ ticketId: ticket.id, remainingMs: remaining }, 'Resumed closing timer for ticket');
  }
}
