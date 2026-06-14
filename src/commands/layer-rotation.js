import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { refreshLiveLayerHighlight, getChannelId } from '../services/layerRotationValidator/layerRotationValidatorScheduler.js';
import { successEmbed, errorEmbed } from '../utils/embed.js';

export default {
  data: new SlashCommandBuilder()
    .setName('layer-rotation')
    .setDescription('Re-post the layer rotation embed in its configured channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    await interaction.deferReply({ flags: ['Ephemeral'] });

    const channelId = getChannelId();
    if (!channelId) {
      return interaction.editReply({
        embeds: [errorEmbed('Layer rotation channel is not configured (`layerRotationValidator.channelId`).')],
      });
    }

    const result = await refreshLiveLayerHighlight(interaction.client);
    if (result.ok) {
      return interaction.editReply({ embeds: [successEmbed(`Layer rotation embed re-posted in <#${channelId}>.`)] });
    }
    return interaction.editReply({ embeds: [errorEmbed(`Could not post rotation embed: ${result.reason}.`)] });
  },
};
