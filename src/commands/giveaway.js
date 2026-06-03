import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { successEmbed, errorEmbed } from '../utils/embed.js';
import {
  createGiveaway,
  getActiveGiveaway,
  setEntryMessage,
  setVoteMessage,
  upsertManualEntry,
  computeLeaderboard,
  windowStartIso,
  listEntries,
  markDrawn,
} from '../services/giveaway/giveawayService.js';
import { buildEntryEmbed, buildEntryRow, buildLeaderboardEmbed, buildVoteMessages, buildWinnerEmbed } from '../services/giveaway/giveawayEmbeds.js';
import { pickWinner } from '../services/giveaway/giveawayDraw.js';
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
    )
    .addSubcommand((s) => s
      .setName('open-vote')
      .setDescription('Post the community vote message (RB-only channel)')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel for vote post (defaults to entry channel)').setRequired(false))
    )
    .addSubcommand((s) => s
      .setName('draw')
      .setDescription('Run the weighted random draw and post the winner')
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'start') return handleStart(interaction);
    if (sub === 'add-entry') return handleAddEntry(interaction);
    if (sub === 'leaderboard') return handleLeaderboard(interaction);
    if (sub === 'open-vote') return handleOpenVote(interaction);
    if (sub === 'draw') return handleDraw(interaction);
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

async function handleOpenVote(interaction) {
  await interaction.deferReply({ flags: ['Ephemeral'] });
  const giveaway = await getActiveGiveaway();
  if (!giveaway) return interaction.editReply({ embeds: [errorEmbed('No active giveaway.')] });
  if (giveaway.status !== 'open') {
    return interaction.editReply({ embeds: [errorEmbed(`Giveaway is in status '${giveaway.status}'; expected 'open'.`)] });
  }

  const entries = await listEntries(giveaway.id);
  if (entries.length === 0) {
    return interaction.editReply({ embeds: [errorEmbed('No one has entered yet.')] });
  }

  const channel = interaction.options.getChannel('channel')
    || await interaction.guild.channels.fetch(giveaway.entry_channel_id);
  if (!channel) {
    return interaction.editReply({ embeds: [errorEmbed('Could not resolve vote channel.')] });
  }

  const enriched = await Promise.all(entries.map(async (e) => {
    const member = await interaction.guild.members.fetch(e.user_id).catch(() => null);
    return { userId: e.user_id, displayName: member?.displayName || e.user_id };
  }));

  const pages = buildVoteMessages(giveaway, enriched);
  let firstMessage = null;
  for (const payload of pages) {
    const sent = await channel.send(payload);
    if (!firstMessage) firstMessage = sent;
  }

  await setVoteMessage(giveaway.id, channel.id, firstMessage.id);

  log.info({ giveawayId: giveaway.id, pages: pages.length, channelId: channel.id }, 'Vote post opened');
  await interaction.editReply({
    embeds: [successEmbed(`Vote post opened in ${channel} (${pages.length} message${pages.length > 1 ? 's' : ''}).`)],
  });
}

async function handleDraw(interaction) {
  await interaction.deferReply({ flags: ['Ephemeral'] });
  const giveaway = await getActiveGiveaway();
  if (!giveaway) return interaction.editReply({ embeds: [errorEmbed('No active giveaway.')] });
  if (giveaway.status === 'drawn') {
    return interaction.editReply({ embeds: [errorEmbed(`Already drawn; winner: <@${giveaway.winner_user_id}>.`)] });
  }
  if (giveaway.status === 'cancelled') {
    return interaction.editReply({ embeds: [errorEmbed('Giveaway is cancelled.')] });
  }

  const leaderboard = await computeLeaderboard(giveaway, windowStartIso(giveaway.window_days));
  const winnerRow = pickWinner(leaderboard);
  if (!winnerRow) {
    return interaction.editReply({ embeds: [errorEmbed('No eligible entries (total tickets is 0).')] });
  }

  await markDrawn(giveaway.id, winnerRow.userId);

  const channel = await interaction.guild.channels.fetch(giveaway.entry_channel_id).catch(() => null);
  const target = channel || interaction.channel;
  await target.send({ embeds: [buildWinnerEmbed(giveaway, winnerRow, leaderboard)] });

  log.info({ giveawayId: giveaway.id, winnerId: winnerRow.userId, tickets: winnerRow.tickets }, 'Giveaway drawn');
  await interaction.editReply({
    embeds: [successEmbed(`Winner posted in ${target}: <@${winnerRow.userId}> with ${winnerRow.tickets} tickets.`)],
  });
}
