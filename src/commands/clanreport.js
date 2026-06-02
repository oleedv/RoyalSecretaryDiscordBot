import { SlashCommandBuilder } from 'discord.js';
import { buildPickerView } from '../services/clanReports/pickerEmbed.js';
import { requireRole } from '../utils/permissions.js';
import { errorEmbed } from '../utils/embed.js';
import config from '../config.js';
import logger from '../logger.js';

const log = logger.child({ module: 'cmd:clanreport' });

const staffRoles = () => config.prospects?.roles || [];

export default {
  data: new SlashCommandBuilder()
    .setName('clanreport')
    .setDescription('Open the interactive clan-report dashboard (staff only)'),

  async execute(interaction) {
    if (await requireRole(interaction, staffRoles())) return;

    try {
      const view = await buildPickerView({ window: '30' });
      await interaction.reply({ embeds: [view.embed], components: view.components });
      log.info({ userId: interaction.user.id, channelId: interaction.channel?.id }, 'clanreport invoked');
    } catch (err) {
      log.error({ err, userId: interaction.user.id }, 'clanreport failed to open picker');
      await interaction.reply({
        embeds: [errorEmbed('Failed to open the clan-report picker.')],
        flags: ['Ephemeral'],
      });
    }
  },
};
