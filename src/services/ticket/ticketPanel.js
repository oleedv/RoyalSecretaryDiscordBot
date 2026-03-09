import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createEmbed } from '../../utils/embed.js';
import { ensurePanel } from '../../utils/panelManager.js';
import config from '../../config.js';

export function buildPanelMessage() {
  const embed = createEmbed('Ticket')
    .setTitle('Royal Battalion - Support Tickets')
    .setDescription(
      'Need to speak with staff? Click the button below to create a ticket.'
    )
    .setColor(0x5865f2)
    .addFields(
      {
        name: 'How It Works',
        value:
          'The bot works through your **DMs**, so your conversation with staff is completely private. ' +
          'If needed, we can restrict ticket access to specific teams.',
      },
      {
        name: 'Reporting Players',
        value:
          'We work on an **evidence-based approach** to admin actions. ' +
          'We strongly recommend backing up reports with evidence - ideally a video ' +
          '(e.g. Nvidia Shadowplay, Medal).\n\n' +
          "If you don't have evidence, don't worry - your report will still be reviewed like any other case.",
      },
      {
        name: 'What to Expect',
        value:
          'Once your ticket is created, a member of staff will respond as soon as possible. ' +
          'Please breifly let us know what you need help with and we will redirect you to the correct team.',
      },
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_create')
      .setLabel('Create Ticket')
      .setStyle(ButtonStyle.Primary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_create_co')
      .setLabel('CO Ticket')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('ticket_create_admin')
      .setLabel('Admin Ticket')
      .setStyle(ButtonStyle.Danger)
  );

  return { embeds: [embed], components: [row, row2] };
}

export async function ensureTicketPanel(client) {
  await ensurePanel(client, config.tickets.panelChannelId, 'ticket_create', buildPanelMessage, 'Ticket');
}
