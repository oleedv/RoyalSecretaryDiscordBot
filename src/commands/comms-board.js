import { SlashCommandBuilder } from 'discord.js';
import { requireRole } from '../utils/permissions.js';
import { successEmbed } from '../utils/embed.js';
import { getBoardPointer, setBoardPointer, clearBoardPointer } from '../services/commsWatch/commsWatchService.js';
import { runMonitorTick, buildCurrentBoardEmbed } from '../services/commsWatch/commsWatchMonitor.js';
import config from '../config.js';
import logger from '../logger.js';

const log = logger.child({ module: 'cmd:comms-board' });
const staffRoles = () => config.prospects?.roles || [];

async function deleteBoard(client, pointer) {
  if (!pointer?.channelId || !pointer?.messageId) return;
  const ch = await client.channels.fetch(pointer.channelId).catch(() => null);
  const msg = ch ? await ch.messages.fetch(pointer.messageId).catch(() => null) : null;
  await msg?.delete().catch(() => null);
}

export default {
  data: new SlashCommandBuilder()
    .setName('comms-board')
    .setDescription('Live board of players in-game but not on Discord voice (staff only)')
    .addSubcommand((s) => s.setName('show').setDescription('Post or move the live comms board to this channel'))
    .addSubcommand((s) => s.setName('stop').setDescription('Remove the live comms board')),

  async execute(interaction) {
    if (await requireRole(interaction, staffRoles())) return;
    const sub = interaction.options.getSubcommand();

    if (sub === 'stop') {
      await deleteBoard(interaction.client, await getBoardPointer());
      await clearBoardPointer();
      return interaction.reply({ embeds: [successEmbed('Comms board removed.')], flags: ['Ephemeral'] });
    }

    // show: single canonical panel — remove any existing board, then post here.
    await interaction.deferReply({ flags: ['Ephemeral'] });
    await deleteBoard(interaction.client, await getBoardPointer());
    await runMonitorTick(interaction.client).catch((err) => log.warn({ err }, 'pre-render tick failed'));
    const embed = await buildCurrentBoardEmbed();
    const posted = await interaction.channel.send({ embeds: [embed] });
    await setBoardPointer(interaction.channel.id, posted.id);
    log.info({ channelId: interaction.channel.id, messageId: posted.id }, 'Comms board posted');
    return interaction.editReply({ embeds: [successEmbed('Comms board posted here. It updates every couple of minutes.')] });
  },
};
