import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { successEmbed, errorEmbed } from '../utils/embed.js';
import {
  createGiveaway,
  getActiveGiveaway,
  setEntryMessage,
} from '../services/giveaway/giveawayService.js';
import { buildEntryEmbed, buildEntryRow } from '../services/giveaway/giveawayEmbeds.js';
import logger from '../logger.js';

const log = logger.child({ module: 'cmd:giveaway' });

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function lastDayOfThisMonthIso() {
  const now = new Date();
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59));
  return last;
}

function currentMonthLabel() {
  const now = new Date();
  return `${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
}

export default {
  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Manage the monthly RB game giveaway')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s
      .setName('start')
      .setDescription('Post a new monthly giveaway entry message')
      .addStringOption((o) => o.setName('prize').setDescription('Prize name').setRequired(true))
      .addChannelOption((o) => o.setName('channel').setDescription('Channel to post the entry message').setRequired(true))
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'start') return handleStart(interaction);
    return interaction.reply({ embeds: [errorEmbed(`Unknown subcommand: ${sub}`)], flags: ['Ephemeral'] });
  },
};

async function handleStart(interaction) {
  await interaction.deferReply({ flags: ['Ephemeral'] });

  const existing = await getActiveGiveaway();
  if (existing) {
    return interaction.editReply({
      embeds: [errorEmbed(`A giveaway is already active (id ${existing.id}, status ${existing.status}). Cancel or draw it first.`)],
    });
  }

  const prize = interaction.options.getString('prize', true);
  const channel = interaction.options.getChannel('channel', true);

  const giveaway = await createGiveaway({
    prize,
    monthLabel: currentMonthLabel(),
    drawAt: lastDayOfThisMonthIso(),
    entryChannelId: channel.id,
    createdBy: interaction.user.id,
  });

  const message = await channel.send({
    embeds: [buildEntryEmbed(giveaway, 0)],
    components: [buildEntryRow(giveaway.id)],
  });

  await setEntryMessage(giveaway.id, channel.id, message.id);

  log.info({ giveawayId: giveaway.id, prize, channelId: channel.id }, 'Giveaway started');
  await interaction.editReply({
    embeds: [successEmbed(`Giveaway #${giveaway.id} posted in ${channel}.\nPrize: **${prize}**`)],
  });
}
