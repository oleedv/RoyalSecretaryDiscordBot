import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { successEmbed, errorEmbed } from '../utils/embed.js';
import {
  createGiveaway,
  getActiveGiveaway,
  setEntryMessage,
  upsertManualEntry,
  computeLeaderboard,
  windowStartIso,
} from '../services/giveaway/giveawayService.js';
import { buildEntryEmbed, buildEntryRow, buildLeaderboardEmbed } from '../services/giveaway/giveawayEmbeds.js';
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
    )
    .addSubcommand((s) => s
      .setName('add-entry')
      .setDescription('Manually add a non-linked community member to the active giveaway')
      .addUserOption((o) => o.setName('user').setDescription('Discord user').setRequired(true))
      .addNumberOption((o) => o.setName('hours').setDescription('Played hours to credit').setRequired(true).setMinValue(0))
      .addNumberOption((o) => o.setName('seed').setDescription('Seed hours to credit').setRequired(true).setMinValue(0))
    )
    .addSubcommand((s) => s
      .setName('leaderboard')
      .setDescription('Show current ticket leaderboard for the active giveaway')
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'start') return handleStart(interaction);
    if (sub === 'add-entry') return handleAddEntry(interaction);
    if (sub === 'leaderboard') return handleLeaderboard(interaction);
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

async function handleAddEntry(interaction) {
  await interaction.deferReply({ flags: ['Ephemeral'] });

  const giveaway = await getActiveGiveaway();
  if (!giveaway) {
    return interaction.editReply({ embeds: [errorEmbed('No active giveaway.')] });
  }
  if (giveaway.status === 'drawn' || giveaway.status === 'cancelled') {
    return interaction.editReply({ embeds: [errorEmbed(`Giveaway is ${giveaway.status}; cannot add entries.`)] });
  }

  const user = interaction.options.getUser('user', true);
  const hours = interaction.options.getNumber('hours', true);
  const seed = interaction.options.getNumber('seed', true);

  await upsertManualEntry(giveaway.id, user.id, hours, seed, interaction.user.id);

  log.info({ giveawayId: giveaway.id, userId: user.id, hours, seed, addedBy: interaction.user.id }, 'Manual entry added');
  await interaction.editReply({
    embeds: [successEmbed(`Added/updated manual entry for ${user}: ${hours}h played, ${seed}h seed.`)],
  });
}

async function handleLeaderboard(interaction) {
  await interaction.deferReply({ flags: ['Ephemeral'] });
  const giveaway = await getActiveGiveaway();
  if (!giveaway) {
    return interaction.editReply({ embeds: [errorEmbed('No active giveaway.')] });
  }
  const leaderboard = await computeLeaderboard(giveaway, windowStartIso(giveaway.window_days));
  await interaction.editReply({ embeds: [buildLeaderboardEmbed(giveaway, leaderboard)] });
}
