import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createEmbed } from '../../utils/embed.js';
import { ensurePanel } from '../../utils/panelManager.js';
import config from '../../config.js';

export function buildPanelMessage() {
  const embed = createEmbed('Info')
    .setTitle('Membership Revoked')
    .setColor(0x5865f2)
    .setDescription(
      'If you are able to view this text channel, your membership in Royal Battalion has been revoked. ' +
      'This action was most likely taken due to prolonged inactivity, though other reasons may apply.\n\n' +
      'We understand this may come as a surprise, and we want to ensure the process remains fair and transparent. ' +
      'If you believe this decision was made in error, or if you wish to discuss the possibility of rejoining as a prospect, ' +
      'you are welcome to open a community ticket.'
    )
    .addFields(
      {
        name: 'How to Submit a Ticket',
        value:
          'Click the button below and briefly describe your situation.\n\n' +
          'A member of our team will review your case and respond as soon as possible. ' +
          'We appreciate your understanding and your time spent as part of the community.',
      },
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('purged_ticket_create')
      .setLabel('Create Community Ticket')
      .setStyle(ButtonStyle.Primary)
  );

  return { embeds: [embed], components: [row] };
}

export async function ensurePurgedPanel(client) {
  await ensurePanel(client, config.purged?.channelId, 'purged_ticket_create', buildPanelMessage, 'Purged');
}
