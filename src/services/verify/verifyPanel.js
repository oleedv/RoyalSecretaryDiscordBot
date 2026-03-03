import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createEmbed } from '../../utils/embed.js';
import { ensurePanel } from '../../utils/panelManager.js';
import config from '../../config.js';

export function buildPanelMessage() {
  const embed = createEmbed('Verification')
    .setTitle('Royal Battalion - Verification')
    .setDescription(
      'To access the server, please verify that you are human by clicking the button below ' +
      'and solving a simple math problem.'
    )
    .setColor(0x5865f2);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('verify_start')
      .setLabel('Verify')
      .setStyle(ButtonStyle.Primary)
  );

  return { embeds: [embed], components: [row] };
}

export async function ensureVerifyPanel(client) {
  await ensurePanel(
    client,
    config.verification?.panelChannelId,
    'verify_start',
    buildPanelMessage,
    'Verification'
  );
}
