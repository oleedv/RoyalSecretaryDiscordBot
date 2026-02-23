import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { buildPanelMessage } from '../services/prospect/prospectPanel.js';
import { errorEmbed, successEmbed } from '../utils/embed.js';
import config from '../config.js';

export default {
  data: new SlashCommandBuilder()
    .setName('prospect-setup')
    .setDescription('Send the prospect application panel to the configured channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    const channelId = config.prospects.panelChannelId;
    if (!channelId) {
      return interaction.reply({ embeds: [errorEmbed('No panel channel configured in settings.js (`prospects.panelChannelId`).')], flags: ['Ephemeral'] });
    }

    const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      return interaction.reply({ embeds: [errorEmbed(`Could not find channel <#${channelId}>.`)], flags: ['Ephemeral'] });
    }

    await channel.send(buildPanelMessage());
    await interaction.reply({ embeds: [successEmbed('Prospect panel sent!')], flags: ['Ephemeral'] });
  },
};
