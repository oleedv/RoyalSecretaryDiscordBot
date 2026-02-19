import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createEmbed } from '../../utils/embed.js';
import { ensurePanel } from '../../utils/panelManager.js';
import config from '../../config.js';

export function buildPanelMessage() {
  const embed = createEmbed('Ticket')
    .setTitle('Royal Battalion — Support Tickets')
    .setDescription(
      'Need help or want to report something? Click the button below to create a private ticket.\n\n' +
      'A staff member will be with you shortly. Please describe your issue in the DM the bot sends you.'
    )
    .setColor(0x5865f2);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_create')
      .setLabel('Create Ticket')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('📩')
  );

  return { embeds: [embed], components: [row] };
}

export async function ensureTicketPanel(client) {
  await ensurePanel(client, config.tickets.panelChannelId, 'ticket_create', buildPanelMessage, 'Ticket');
}
