import { randomUUID } from 'crypto';
import { ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createEmbed, infoEmbed } from '../../utils/embed.js';
import { buildPrivateChannelPermissions } from '../../utils/permissions.js';
import { findBotMessageByCustomId } from '../../utils/messageSearch.js';
import { buildTicketInfoEmbed, buildTicketComponents, TIER_CHANNEL_PREFIX, TIER_LABELS, TIER_COLORS } from './ticketEmbeds.js';
import { query } from '../../database/connection.js';
import { getStoredSteamId } from '../userService.js';
import { resolvePlayerId } from '../battlemetricsService.js';
import config from '../../config.js';
import logger from '../../logger.js';

const log = logger.child({ module: 'tickets' });

const GRACE_PERIOD_MS = 2 * 60 * 60 * 1000; // 2 hours

// In-memory timer store for closing grace periods (channelId → timeout ref)
const closingTimers = new Map();

// In-memory store for anonymous mode toggle (channelId → boolean)
const anonymousModes = new Map();

export async function isAnonymousMode(channelId) {
  const cached = anonymousModes.get(channelId);
  if (cached !== undefined) return cached;

  const rows = await query(
    'SELECT anonymous_mode FROM tickets WHERE channel_id = ? AND status = ?',
    [channelId, 'open']
  );
  const value = rows[0]?.anonymous_mode === 1;
  anonymousModes.set(channelId, value);
  return value;
}

export async function setAnonymousMode(channelId, enabled) {
  if (enabled) anonymousModes.set(channelId, true);
  else anonymousModes.set(channelId, false);

  await query(
    'UPDATE tickets SET anonymous_mode = ? WHERE channel_id = ? AND status = ?',
    [enabled ? 1 : 0, channelId, 'open']
  );
}

/**
 * Find the info embed message for a ticket channel.
 * Tries findBotMessageByCustomId first, falls back to stored info_message_id.
 */
export async function findTicketInfoMessage(channel, botUserId, ticket) {
  const customIds = ['ticket_close', 'ticket_escalate_co', 'ticket_escalate_admin', 'ticket_escalate_comp', 'ticket_escalate_wl', 'ticket_escalate_normal'];
  const msg = await findBotMessageByCustomId(channel, botUserId, customIds);
  if (msg) return msg;

  if (ticket?.info_message_id) {
    return channel.messages.fetch(ticket.info_message_id).catch(() => null);
  }
  return null;
}

async function deleteLogsEmbeds(channel, botId) {
  const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (!messages) return;
  const toDelete = messages.filter((msg) =>
    msg.author.id === botId && msg.embeds.some((e) => e.title?.startsWith('Previous Tickets'))
  );
  if (toDelete.size === 0) return;
  if (toDelete.size === 1) {
    await toDelete.first().delete().catch(() => null);
    return;
  }
  await channel.bulkDelete(toDelete, true).catch(() => null);
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
  const legacyUnion = `
    UNION ALL
    SELECT lt.uuid, 'legacy' AS tier, lt.started_at AS created_at,
      (SELECT ltm.content FROM legacy_ticket_messages ltm WHERE ltm.ticket_id = lt.id AND ltm.type = 'from_user' ORDER BY ltm.id ASC LIMIT 1) AS first_message
    FROM legacy_tickets lt WHERE lt.user_id = ?`;

  if (tier === 'normal') {
    return await query(
      `SELECT t.uuid, t.tier, t.created_at, (SELECT tm.content FROM ticket_messages tm WHERE tm.ticket_id = t.id AND tm.is_staff = 0 ORDER BY tm.id ASC LIMIT 1) AS first_message FROM tickets t WHERE t.user_id = ? AND t.status = ? AND t.tier = ?${legacyUnion} ORDER BY created_at DESC`,
      [userId, 'closed', tier, userId]
    );
  }
  return await query(
    `SELECT t.uuid, t.tier, t.created_at, (SELECT tm.content FROM ticket_messages tm WHERE tm.ticket_id = t.id AND tm.is_staff = 0 ORDER BY tm.id ASC LIMIT 1) AS first_message FROM tickets t WHERE t.user_id = ? AND t.status = ? AND t.tier IN (?, ?)${legacyUnion} ORDER BY created_at DESC`,
    [userId, 'closed', tier, 'normal', userId]
  );
}

export async function getAllClosedTicketsByUser(userId) {
  return await query(
    `SELECT t.uuid, t.tier, t.created_at, (SELECT tm.content FROM ticket_messages tm WHERE tm.ticket_id = t.id AND tm.is_staff = 0 ORDER BY tm.id ASC LIMIT 1) AS first_message FROM tickets t WHERE t.user_id = ? AND t.status = ?
    UNION ALL
    SELECT lt.uuid, 'legacy' AS tier, lt.started_at AS created_at,
      (SELECT ltm.content FROM legacy_ticket_messages ltm WHERE ltm.ticket_id = lt.id AND ltm.type = 'from_user' ORDER BY ltm.id ASC LIMIT 1) AS first_message
    FROM legacy_tickets lt WHERE lt.user_id = ?
    ORDER BY created_at DESC`,
    [userId, 'closed', userId]
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
  const member = await guild.members.fetch(userId).catch(() => null);
  const prefix = TIER_CHANNEL_PREFIX[tier] || '';
  const channelName = member
    ? `${prefix}ticket-${member.user.username.slice(0, 10)}`
    : `${prefix}ticket-${uuid.slice(0, 6)}`;
  const { categoryId, roles } = config.tickets;

  const configKey = tierConfigKey[tier] || 'normal';
  const tierRoles = roles[configKey] || roles.normal;
  const permissionOverwrites = buildPrivateChannelPermissions(guild, tierRoles);

  const channel = await guild.channels.create({
    name: channelName,
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

  const userTag = member?.user.tag || userId;

  const [previousTickets, bmPlayerId] = await Promise.all([
    getClosedTicketsByUser(userId, tier),
    steamId ? resolvePlayerId(steamId) : null,
  ]);
  const embed = buildTicketInfoEmbed(userTag, userId, uuid, tier, previousTickets.length, { steamId, reason, bmPlayerId });
  const components = buildTicketComponents(tier);

  const displayName = member?.displayName || member?.user.username || userId;
  const tierLabel = TIER_LABELS[tier] || tier;
  const notifContent = tier === 'normal'
    ? `New ticket from ${displayName}`
    : `New ${tierLabel} ticket from ${displayName}`;

  const infoMsg = await channel.send({ content: notifContent, embeds: [embed], components, allowedMentions: { parse: [] } });
  await query('UPDATE tickets SET info_message_id = ? WHERE id = ?', [infoMsg.id, ticket.id]);

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

  // Build the full overwrite array in one PUT to avoid 5+ sequential REST calls.
  // Preserve any overwrites we don't manage (e.g. manual member additions, bot, @everyone).
  const preserved = channel.permissionOverwrites.cache
    .filter((ow) => !allRoles.has(ow.id))
    .map((ow) => ({
      id: ow.id,
      type: ow.type,
      allow: ow.allow.bitfield,
      deny: ow.deny.bitfield,
    }));
  const tierOverwrites = [...rolesToKeep].map((roleId) => ({
    id: roleId,
    allow: ['ViewChannel', 'SendMessages'],
  }));
  await channel.permissionOverwrites.set([...preserved, ...tierOverwrites]).catch((err) => {
    log.error({ err, channelId: channel.id }, 'Failed to update channel permission overwrites');
  });

  await query('UPDATE tickets SET tier = ? WHERE id = ?', [tier, ticket.id]);

  // Rename the channel to match the new tier prefix
  const newPrefix = TIER_CHANNEL_PREFIX[tier] || '';
  const knownPrefixes = Object.values(TIER_CHANNEL_PREFIX)
    .filter(Boolean)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const stripRegex = new RegExp(`^(${knownPrefixes})`, 'i');
  const baseName = channel.name.replace(stripRegex, '');
  const newName = `${newPrefix}${baseName}`;
  if (newName.toLowerCase() !== channel.name.toLowerCase()) {
    await channel.setName(newName).catch((err) => {
      log.error({ err, channelId: channel.id }, 'Failed to rename channel on escalation');
    });
  }

  await query(
    'INSERT INTO ticket_events (ticket_id, event_type, actor_id, detail) VALUES (?, ?, ?, ?)',
    [ticket.id, 'escalated', actorId || channel.guild.members.me.id, tier]
  );

  const member = await channel.guild.members.fetch(ticket.user_id).catch(() => null);
  const userTag = member?.user.tag || ticket.user_id;

  const steamId = await getStoredSteamId(ticket.user_id);
  const [previousTickets, bmPlayerId] = await Promise.all([
    getClosedTicketsByUser(ticket.user_id, tier),
    steamId ? resolvePlayerId(steamId) : null,
  ]);
  const infoEmbed = buildTicketInfoEmbed(userTag, ticket.user_id, ticket.uuid, tier, previousTickets.length, { steamId, reason: ticket.reason, bmPlayerId });
  const components = buildTicketComponents(tier, await isAnonymousMode(channel.id));

  const topMsg = await findTicketInfoMessage(channel, channel.client.user.id, { ...ticket, tier });
  if (topMsg) {
    await topMsg.edit({ embeds: [infoEmbed], components });
  }

  // Remove any !logs embeds from the previous team
  await deleteLogsEmbeds(channel, channel.client.user.id);

  const tierLabel = TIER_LABELS[tier] || tier;
  const actor = actorId ? await channel.guild.members.fetch(actorId).catch(() => null) : null;
  const actorName = actor?.displayName || 'Unknown';
  const notifEmbed = createEmbed('Ticket')
    .setTitle('Ticket Transferred')
    .setDescription(`This ticket has been transferred to **${tierLabel}** by **${actorName}**.`)
    .setColor(TIER_COLORS[tier] || 0x5865f2);

  // Send notification embed + role ping in a single message
  const targetRoles = tierRoleMap[tier];
  const escalatePing = targetRoles.map((r) => `<@&${r}>`).join(' ');
  await channel.send({
    content: escalatePing,
    embeds: [notifEmbed],
    allowedMentions: { roles: targetRoles },
  });

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
  const topMsg = await findTicketInfoMessage(channel, client.user.id, ticket);
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
  const closedByMember = await channel.guild.members.fetch(closedById).catch(() => null);
  const closedByName = closedByMember?.displayName || 'Unknown';
  const deleteAt = Math.floor((Date.now() + GRACE_PERIOD_MS) / 1000);
  const closedEmbed = createEmbed('Ticket')
    .setTitle('Ticket Closed')
    .setDescription(`This ticket has been closed by **${closedByName}**. The channel will be deleted <t:${deleteAt}:R>.\n\nStaff can reopen it or force close it with the buttons below. The user can also reply via DM to reopen.`)
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
      embeds: [infoEmbed('Your ticket has been closed. If you need to add anything, reply here within the next two hours and your ticket will be reopened automatically.')],
    }).catch(() => null);
  }

  // Schedule channel deletion after grace period
  const timer = setTimeout(async () => {
    closingTimers.delete(channel.id);
    anonymousModes.delete(channel.id);
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
  anonymousModes.delete(ticket.channel_id);

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
  const result = await query(
    'UPDATE tickets SET status = ?, closed_at = NULL, closed_by = NULL WHERE id = ? AND status = ?',
    ['open', ticket.id, 'closing']
  );
  if (result.affectedRows === 0) return { error: 'Ticket already reopened or closed.' };

  const timer = closingTimers.get(ticket.channel_id);
  if (timer) {
    clearTimeout(timer);
    closingTimers.delete(ticket.channel_id);
  }

  await query(
    'INSERT INTO ticket_events (ticket_id, event_type, actor_id) VALUES (?, ?, ?)',
    [ticket.id, 'reopened', reopenedById]
  );

  log.info({ ticketId: ticket.id, reopenedBy: reopenedById }, 'Ticket reopened');
  return {};
}

/**
 * Rebuild the ticket info embed after a reopen. Cleans up stale closing messages
 * and sends a fresh info embed with active buttons.
 */
export async function rebuildTicketInfoEmbed(ticket, channel, client) {
  // Clean up stale messages from the closing state
  const closedMsg = await findBotMessageByCustomId(channel, client.user.id, ['ticket_reopen']);
  if (closedMsg) await closedMsg.delete().catch(() => null);
  const oldInfoMsg = await findTicketInfoMessage(channel, client.user.id, ticket);
  if (oldInfoMsg) await oldInfoMsg.delete().catch(() => null);

  // Send fresh info embed with active buttons
  const member = await channel.guild.members.fetch(ticket.user_id).catch(() => null);
  const userTag = member?.user.tag || ticket.user_id;
  const steamId = await getStoredSteamId(ticket.user_id);
  const [previousTickets, bmPlayerId] = await Promise.all([
    getClosedTicketsByUser(ticket.user_id, ticket.tier),
    steamId ? resolvePlayerId(steamId) : null,
  ]);
  const embed = buildTicketInfoEmbed(userTag, ticket.user_id, ticket.uuid, ticket.tier, previousTickets.length, { steamId, reason: ticket.reason, bmPlayerId });
  const components = buildTicketComponents(ticket.tier);

  const infoMsg = await channel.send({ embeds: [embed], components });
  await query('UPDATE tickets SET info_message_id = ? WHERE id = ?', [infoMsg.id, ticket.id]);
}

/**
 * Restore anonymous mode state from DB for all open tickets after a bot restart.
 * Call this from the ready event handler.
 */
export async function restoreAnonymousModes() {
  const rows = await query('SELECT channel_id FROM tickets WHERE anonymous_mode = 1 AND status = ?', ['open']);
  for (const row of rows) {
    anonymousModes.set(row.channel_id, true);
  }
  if (rows.length > 0) {
    log.info({ count: rows.length }, 'Restored anonymous modes from DB');
  }
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
