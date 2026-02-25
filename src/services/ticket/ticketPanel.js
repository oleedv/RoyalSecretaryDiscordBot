import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createEmbed } from '../../utils/embed.js';
import { ensurePanel } from '../../utils/panelManager.js';
import config from '../../config.js';

export function buildPanelMessage() {
  const embed = createEmbed('Ticket')
    .setTitle('Royal Battalion — Support Tickets')
    .setDescription(
      'Need to speak with the admin team? Click the button below to create a ticket.'
    )
    .setColor(0x5865f2)
    .addFields(
      {
        name: 'How It Works',
        value:
          'The bot works through your **DMs**, so your conversation with the admin team is completely private. ' +
          'If needed, we can restrict ticket access to specific teams.',
      },
      {
        name: 'Reporting Players',
        value:
          'We work on an **evidence-based approach** to admin actions. ' +
          'We strongly recommend backing up reports with evidence — ideally a video ' +
          '(e.g. GeForce Experience, Medal).\n\n' +
          "If you don't have evidence, don't worry — your report will still be reviewed like any other case.",
      },
      {
        name: 'What to Expect',
        value:
          'Once your ticket is created, a member of the admin team will respond as soon as possible. ' +
          'Please describe your issue clearly so we can help you efficiently.',
      },
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_create')
      .setLabel('Create Ticket')
      .setStyle(ButtonStyle.Primary)
  );

  return { embeds: [embed], components: [row] };
}

export async function ensureTicketPanel(client) {
  await ensurePanel(client, config.tickets.panelChannelId, 'ticket_create', buildPanelMessage, 'Ticket');
}
