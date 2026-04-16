import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { saveConfig, getConfig } from '../services/tempvoice/tempvoiceService.js';
import { loadConfig } from '../services/tempvoice/tempvoiceManager.js';
import { successEmbed, errorEmbed } from '../utils/embed.js';

export default {
  data: new SlashCommandBuilder()
    .setName('tempvoice-setup')
    .setDescription('Configure temporary voice channels')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption((opt) =>
      opt
        .setName('trigger')
        .setDescription('Voice channel users join to create a temp channel')
        .addChannelTypes(ChannelType.GuildVoice)
        .setRequired(true),
    )
    .addChannelOption((opt) =>
      opt
        .setName('category')
        .setDescription('Category where temp channels are created')
        .addChannelTypes(ChannelType.GuildCategory)
        .setRequired(true),
    )
    .addChannelOption((opt) =>
      opt
        .setName('log-channel')
        .setDescription('Channel for tempvoice event logs (optional)')
        .addChannelTypes(ChannelType.GuildText),
    ),

  async execute(interaction) {
    const trigger = interaction.options.getChannel('trigger');
    const category = interaction.options.getChannel('category');
    const logChannel = interaction.options.getChannel('log-channel');

    try {
      await saveConfig(trigger.id, category.id, logChannel?.id || null);
      await loadConfig(); // Refresh cached config

      const lines = [
        `**Trigger channel:** ${trigger}`,
        `**Category:** ${category}`,
        logChannel ? `**Log channel:** ${logChannel}` : '**Log channel:** None',
      ];

      await interaction.reply({
        embeds: [successEmbed(`RoyalVoice configured.\n\n${lines.join('\n')}`)],
        flags: ['Ephemeral'],
      });
    } catch (err) {
      await interaction.reply({
        embeds: [errorEmbed('Failed to save configuration.')],
        flags: ['Ephemeral'],
      });
    }
  },
};
