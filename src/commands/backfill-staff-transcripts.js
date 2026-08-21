import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { backfillOpenStaffChannels } from '../services/channelTranscript/channelTranscript.js';
import { successEmbed, errorEmbed } from '../utils/embed.js';
import logger from '../logger.js';

const log = logger.child({ module: 'cmd:backfill-staff-transcripts' });
const OWNER_ID = '195412349153312768';

export default {
  data: new SlashCommandBuilder()
    .setName('backfill-staff-transcripts')
    .setDescription('Pull ticket/prospect channel history (including Discord threads) into the website transcript')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    if (interaction.user.id !== OWNER_ID) {
      return interaction.reply({ embeds: [errorEmbed('This command is restricted.')], flags: ['Ephemeral'] });
    }

    await interaction.deferReply({ flags: ['Ephemeral'] });

    try {
      const { tickets, prospects } = await backfillOpenStaffChannels(interaction.client);
      log.info({ tickets, prospects }, 'Manual staff transcript backfill finished');
      return interaction.editReply({
        embeds: [successEmbed(`Inserted **${tickets}** ticket messages and **${prospects}** prospect messages from still-open staff channels.`)],
      });
    } catch (err) {
      log.error({ err }, 'Manual staff transcript backfill failed');
      return interaction.editReply({ embeds: [errorEmbed(`Backfill failed: ${err.message}`)] });
    }
  },
};
