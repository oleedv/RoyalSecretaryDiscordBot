import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { buildPanelMessage } from '../services/ticket/ticketPanel.js';
import { errorEmbed, successEmbed } from '../utils/embed.js';
import config from '../config.js';

export default {
  data: new SlashCommandBuilder()
    .setName('ticket-setup')
    .setDescription('Send the ticket creation panel to the configured channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    const channelId = config.tickets.panelChannelId;
    if (!channelId) {
      return interaction.reply({ embeds: [errorEmbed('No panel channel configured in settings.js (`tickets.panelChannelId`).')], flags: ['Ephemeral'] });
    }

    const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      return interaction.reply({ embeds: [errorEmbed(`Could not find channel <#${channelId}>.`)], flags: ['Ephemeral'] });
    }

    await channel.send(buildPanelMessage());
    await interaction.reply({ embeds: [successEmbed('Ticket panel sent!')], flags: ['Ephemeral'] });
  },
};
