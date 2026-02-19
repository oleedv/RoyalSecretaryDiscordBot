import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createEmbed } from '../../utils/embed.js';
import { ensurePanel } from '../../utils/panelManager.js';
import config from '../../config.js';

export function buildPanelMessage() {
  const embed = createEmbed('Prospect')
    .setTitle('Royal Battalion — Join RB')
    .setDescription(
      'Interested in joining Royal Battalion? Click the button below to start your application.\n\n' +
      'You will be asked to fill out a short form. After submission, a staff member will review your application.'
    )
    .setColor(0x57f287);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('prospect_apply')
      .setLabel('Join RB')
      .setStyle(ButtonStyle.Success)
      .setEmoji('📋')
  );

  return { embeds: [embed], components: [row] };
}

export async function ensureProspectPanel(client) {
  await ensurePanel(client, config.prospects.panelChannelId, 'prospect_apply', buildPanelMessage, 'Prospect');
}
