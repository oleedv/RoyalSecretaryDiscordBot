import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { DateTime } from 'luxon';
import { getUserTimezone } from '../services/timestamp/timestampService.js';
import { infoEmbed } from '../utils/embed.js';

export default {
  data: new SlashCommandBuilder()
    .setName('timezone')
    .setDescription('View or clear the timezone saved for your /timestamp command'),

  async execute(interaction) {
    const saved = await getUserTimezone(interaction.user.id);

    if (!saved) {
      return interaction.reply({
        embeds: [infoEmbed(
          'You don\'t have a saved timezone yet. Use `/timestamp` with the `timezone` option (start typing a city) and I\'ll remember it.'
        )],
        flags: ['Ephemeral'],
      });
    }

    const now = DateTime.now().setZone(saved);
    const localTime = now.isValid ? now.toFormat('cccc HH:mm') : 'unknown';

    const clearRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('tz_clear').setLabel('Clear my timezone').setStyle(ButtonStyle.Danger)
    );

    await interaction.reply({
      embeds: [infoEmbed(`Your saved timezone is **${saved}** (local time ${localTime}).`)],
      components: [clearRow],
      flags: ['Ephemeral'],
    });
  },
};
