import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { saveConfig, setDefaultAllowVad, getConfig } from '../services/tempvoice/tempvoiceService.js';
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
    )
    .addBooleanOption((opt) =>
      opt
        .setName('voice-activation')
        .setDescription('Allow voice activation on new channels (default: true)'),
    ),

  async execute(interaction) {
    const trigger = interaction.options.getChannel('trigger');
    const category = interaction.options.getChannel('category');
    const logChannel = interaction.options.getChannel('log-channel');
    const voiceActivation = interaction.options.getBoolean('voice-activation');

    try {
      await saveConfig(trigger.id, category.id, logChannel?.id || null);
      if (voiceActivation !== null) await setDefaultAllowVad(voiceActivation);
      await loadConfig(); // Refresh cached config

      const config = await getConfig();
      const vadOn = (config.default_allow_vad ?? 1) ? 'enabled' : 'disabled';

      const lines = [
        `**Trigger channel:** ${trigger}`,
        `**Category:** ${category}`,
        logChannel ? `**Log channel:** ${logChannel}` : '**Log channel:** None',
        `**Voice activation default:** ${vadOn}`,
      ];

      await interaction.reply({
        embeds: [successEmbed(`RB Voice configured.\n\n${lines.join('\n')}`)],
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
