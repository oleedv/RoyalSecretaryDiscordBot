import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { triggerNow } from '../services/moderation/moderationScheduler.js';
import { successEmbed, errorEmbed } from '../utils/embed.js';
import config from '../config.js';
import logger from '../logger.js';

const log = logger.child({ module: 'cmd:modreport' });

const OWNER_ID = '195412349153312768';

export default {
  data: new SlashCommandBuilder()
    .setName('modreport')
    .setDescription('Trigger the daily AI chat moderation report immediately (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    if (interaction.user.id !== OWNER_ID) {
      return interaction.reply({ embeds: [errorEmbed('This command is restricted.')], flags: ['Ephemeral'] });
    }

    if (!config.moderation?.channelId) {
      return interaction.reply({ embeds: [errorEmbed('Moderation channelId is not configured for this environment.')], flags: ['Ephemeral'] });
    }

    await interaction.deferReply({ flags: ['Ephemeral'] });

    try {
      const result = await triggerNow(interaction.client);
      const summary = `Status: \`${result.status}\``
        + (result.definite != null ? ` • definite=${result.definite} possible=${result.possible}` : '')
        + (result.error ? `\nError: ${result.error}` : '');
      await interaction.editReply({ embeds: [successEmbed(`Moderation run completed.\n${summary}`)] });
    } catch (err) {
      log.error({ err }, 'Manual moderation trigger failed');
      await interaction.editReply({ embeds: [errorEmbed(`Moderation run failed: ${err.message}`)] });
    }
  },
};
