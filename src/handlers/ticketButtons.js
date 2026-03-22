import { getStoredSteamId } from '../services/userService.js';
import { rawModal, labelComponent, textInput, checkboxGroup } from '../utils/modalComponents.js';
import {
  getTicketByChannel,
  getTicketByChannelStatus,
  escalateTicket,
  beginCloseGracePeriod,
  reopenTicket,
  forceCloseTicket,
  timeoutUser,
  getClosedTicketsByUser,
  getAllClosedTicketsByUser,
} from '../services/ticket/ticketService.js';
import { buildTicketInfoEmbed, buildTicketComponents } from '../services/ticket/ticketEmbeds.js';
import { errorEmbed, infoEmbed } from '../utils/embed.js';
import { requireRole } from '../utils/permissions.js';
import { findBotMessageByCustomId } from '../utils/messageSearch.js';
import { buildLogsPage } from './ticketMessages.js';
import config from '../config.js';
import logger from '../logger.js';

const log = logger.child({ module: 'ticketButtons' });

const allTicketStaffRoles = () => {
  const r = config.tickets.roles || {};
  return [...(r.normal || []), ...(r.communityOfficer || []), ...(r.adminOfficer || []), ...(r.compTeam || []), ...(r.whitelist || [])];
};

export async function handleCreate(interaction) {
  const storedSteamId = await getStoredSteamId(interaction.user.id);
  const modalId = storedSteamId ? 'ticket_create_modal_quick' : 'ticket_create_modal';

  const components = [
    labelComponent('Team', checkboxGroup('ticket_teams', [
      { label: 'Normal', value: 'normal', default: true },
      { label: 'Community Officer (Members Only)', value: 'community_officer' },
      { label: 'Admin Officer (Members Only)', value: 'admin_officer' },
    ], { minValues: 1, maxValues: 1 })),
  ];

  if (!storedSteamId) {
    components.push(
      labelComponent('Steam ID (Steam64 or profile URL)', textInput('ticket_steam_id', 'short', {
        placeholder: 'e.g. 76561198012345678',
        required: true,
      }))
    );
  }

  components.push(
    labelComponent('Why are you creating this ticket?', textInput('ticket_reason', 'paragraph', {
      placeholder: 'Briefly describe your issue...',
      minLength: 5,
      maxLength: 500,
      required: true,
    }))
  );

  await interaction.showModal(rawModal(modalId, 'Create a Support Ticket', components));
}

export async function handleEscalate(interaction) {
  if (await requireRole(interaction, allTicketStaffRoles())) return;
  await interaction.deferReply({ flags: ['Ephemeral'] });
  const ticket = await getTicketByChannel(interaction.channel.id);
  if (!ticket) return interaction.editReply({ embeds: [errorEmbed('No open ticket found for this channel.')] });

  const tierMap = {
    ticket_escalate_normal: 'normal',
    ticket_escalate_co: 'community_officer',
    ticket_escalate_admin: 'admin_officer',
    ticket_escalate_comp: 'comp_team',
    ticket_escalate_wl: 'whitelist',
  };
  const tier = tierMap[interaction.customId];
  const result = await escalateTicket(ticket, tier, interaction.channel, interaction.user.id);
  if (result.error) {
    return interaction.editReply({ embeds: [errorEmbed(result.error)] });
  }

  await interaction.deleteReply();
  log.info({ ticketId: ticket.id, tier }, 'Ticket escalated');
}

export async function handleClose(interaction) {
  if (await requireRole(interaction, allTicketStaffRoles())) return;
  await interaction.deferReply({ flags: ['Ephemeral'] });
  const ticket = await getTicketByChannel(interaction.channel.id);
  if (!ticket) return interaction.editReply({ embeds: [errorEmbed('No open ticket found for this channel.')] });

  await beginCloseGracePeriod(ticket, interaction.user.id, interaction.channel, interaction.client);
  await interaction.deleteReply();
  log.info({ ticketId: ticket.id, closedBy: interaction.user.id }, 'Ticket closed via button');
}

export async function handleReopen(interaction) {
  if (await requireRole(interaction, allTicketStaffRoles())) return;
  await interaction.deferReply({ flags: ['Ephemeral'] });
  const ticket = await getTicketByChannelStatus(interaction.channel.id, 'closing');
  if (!ticket) return interaction.editReply({ embeds: [errorEmbed('No closing ticket found for this channel.')] });

  await reopenTicket(ticket, interaction.user.id);

  // Delete the "Ticket Closed" message that had the Reopen button
  await interaction.message.delete().catch(() => null);

  // Delete the old disabled info embed
  const oldInfoMsg = await findBotMessageByCustomId(interaction.channel, interaction.client.user.id, ['ticket_close']);
  if (oldInfoMsg) await oldInfoMsg.delete().catch(() => null);

  // Send fresh info embed with active buttons
  const member = await interaction.guild.members.fetch(ticket.user_id).catch(() => null);
  const userTag = member?.user.tag || ticket.user_id;
  const steamId = await getStoredSteamId(ticket.user_id);
  const previousTickets = await getClosedTicketsByUser(ticket.user_id, ticket.tier);
  const embed = buildTicketInfoEmbed(userTag, ticket.user_id, ticket.uuid, ticket.tier, previousTickets.length, { steamId, reason: ticket.reason });
  const components = buildTicketComponents(ticket.tier);

  await interaction.channel.send({ embeds: [embed], components });

  // DM the user
  const user = await interaction.client.users.fetch(ticket.user_id).catch(() => null);
  if (user) {
    await user.send({ embeds: [infoEmbed('Your ticket has been reopened. A staff member will continue assisting you.')] }).catch(() => null);
  }

  await interaction.deleteReply();
  log.info({ ticketId: ticket.id, reopenedBy: interaction.user.id }, 'Ticket reopened via button');
}

export async function handleForceClose(interaction) {
  if (await requireRole(interaction, allTicketStaffRoles())) return;
  await interaction.deferReply({ flags: ['Ephemeral'] });
  const ticket = await getTicketByChannelStatus(interaction.channel.id, 'closing');
  if (!ticket) return interaction.editReply({ embeds: [errorEmbed('No closing ticket found for this channel.')] });

  log.info({ ticketId: ticket.id, closedBy: interaction.user.id }, 'Ticket force closed via button');
  await forceCloseTicket(ticket, interaction.channel);
}

export async function handleTimeout(interaction) {
  if (await requireRole(interaction, allTicketStaffRoles())) return;
  await interaction.deferReply({ flags: ['Ephemeral'] });
  const ticket = await getTicketByChannel(interaction.channel.id);
  if (!ticket) return interaction.editReply({ embeds: [errorEmbed('No open ticket found for this channel.')] });

  const result = await timeoutUser(ticket.user_id, interaction.user.id);
  if (result.error) {
    return interaction.editReply({ embeds: [errorEmbed(result.error)] });
  }

  // DM the user
  const user = await interaction.client.users.fetch(ticket.user_id).catch(() => null);
  if (user) {
    await user.send({
      embeds: [errorEmbed('You have been temporarily prevented from creating support tickets for 24 hours. Please try again later.')],
    }).catch(() => null);
  }

  // Notify the channel
  await interaction.channel.send({
    embeds: [infoEmbed(`<@${ticket.user_id}> has been timed out from creating tickets for 24 hours.`)],
  });

  await interaction.deleteReply();
  log.info({ ticketId: ticket.id, targetUserId: ticket.user_id, staffId: interaction.user.id }, 'User timed out via ticket button');
}

export async function handleLogsPagination(interaction) {
  const parts = interaction.customId.split(':');
  const page = parseInt(parts[1], 10);
  const userId = parts[2];
  const tier = parts[3];

  await interaction.deferUpdate();

  const previous = tier === 'all'
    ? await getAllClosedTicketsByUser(userId)
    : await getClosedTicketsByUser(userId, tier);
  if (previous.length === 0) {
    return interaction.message.edit({ content: 'This user has no previous tickets.', embeds: [], components: [] });
  }

  const { embed, components } = buildLogsPage(previous, page, userId, tier);
  await interaction.message.edit({ embeds: [embed], components });
}
