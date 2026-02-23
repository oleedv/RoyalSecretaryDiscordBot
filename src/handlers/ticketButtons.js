import {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from 'discord.js';
import { getTicketByChannel, escalateTicket, closeTicket } from '../services/ticket/ticketService.js';
import { errorEmbed, successEmbed, infoEmbed } from '../utils/embed.js';
import logger from '../logger.js';

const log = logger.child({ module: 'ticketButtons' });

export async function handleCreate(interaction) {
  const ticketModal = new ModalBuilder()
    .setCustomId('ticket_create_modal')
    .setTitle('Create a Support Ticket');

  ticketModal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('ticket_steam_id')
        .setLabel('Steam ID (Steam64, profile URL, or Q to skip)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. 76561198012345678')
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('ticket_reason')
        .setLabel('Why are you creating this ticket?')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Briefly describe your issue...')
        .setMinLength(5)
        .setMaxLength(500)
        .setRequired(true)
    )
  );

  await interaction.showModal(ticketModal);
}

export async function handleEscalate(interaction) {
  await interaction.deferReply({ flags: ['Ephemeral'] });
  const ticket = await getTicketByChannel(interaction.channel.id);
  if (!ticket) return interaction.editReply({ embeds: [errorEmbed('No open ticket found for this channel.')] });

  const tier = interaction.customId === 'ticket_escalate_co' ? 'community_officer' : 'admin_officer';
  const result = await escalateTicket(ticket, tier, interaction.channel);
  if (result.error) {
    return interaction.editReply({ embeds: [errorEmbed(result.error)] });
  }

  const tierLabel = tier === 'community_officer' ? 'Community Officer' : 'Admin Officer';
  await interaction.editReply({ embeds: [successEmbed(`Ticket escalated to ${tierLabel}.`)] });
  log.info({ ticketId: ticket.id, tier }, 'Ticket escalated');
}

export async function handleClose(interaction) {
  await interaction.deferReply({ flags: ['Ephemeral'] });
  const ticket = await getTicketByChannel(interaction.channel.id);
  if (!ticket) return interaction.editReply({ embeds: [errorEmbed('No open ticket found for this channel.')] });

  await closeTicket(ticket, interaction.user.id);

  const user = await interaction.client.users.fetch(ticket.user_id).catch(() => null);
  if (user) {
    await user.send({ embeds: [infoEmbed('Your ticket has been closed. Thank you!')] }).catch(() => null);
  }

  log.info({ ticketId: ticket.id, closedBy: interaction.user.id }, 'Ticket closed via button');
  await interaction.channel.delete().catch(() => null);
}
