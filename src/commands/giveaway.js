import { SlashCommandBuilder } from 'discord.js';
import { successEmbed, errorEmbed } from '../utils/embed.js';
import { computeLeaderboard, getActiveGiveaway, windowStartIso } from '../services/giveaway/giveawayService.js';
import { buildLeaderboardEmbed } from '../services/giveaway/giveawayEmbeds.js';
import {
  GiveawayActionError,
  startGiveaway,
  addManualGiveawayEntry,
  openGiveawayVote,
  drawGiveaway,
  cancelActiveGiveaway,
} from '../services/giveaway/giveawayActions.js';
import logger from '../logger.js';

const log = logger.child({ module: 'cmd:giveaway' });

export default {
  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Manage the monthly RB game giveaway')
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
    )
    .addSubcommand((s) => s
      .setName('cancel')
      .setDescription('Cancel the active giveaway and delete its messages')
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'start') return handleStart(interaction);
    if (sub === 'add-entry') return handleAddEntry(interaction);
    if (sub === 'leaderboard') return handleLeaderboard(interaction);
    if (sub === 'open-vote') return handleOpenVote(interaction);
    if (sub === 'draw') return handleDraw(interaction);
    if (sub === 'cancel') return handleCancel(interaction);
    return interaction.reply({ embeds: [errorEmbed(`Unknown subcommand: ${sub}`)], flags: ['Ephemeral'] });
  },
};

async function runAction(interaction, fn) {
  await interaction.deferReply({ flags: ['Ephemeral'] });
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GiveawayActionError) {
      return interaction.editReply({ embeds: [errorEmbed(err.message)] });
    }
    log.error({ err }, 'giveaway command failed');
    return interaction.editReply({ embeds: [errorEmbed('Something went wrong.')] });
  }
}

async function handleStart(interaction) {
  return runAction(interaction, async () => {
    const prize = interaction.options.getString('prize', true);
    const channel = interaction.options.getChannel('channel', true);
    const { giveaway } = await startGiveaway({
      client: interaction.client,
      prize,
      channel,
      createdBy: interaction.user.id,
    });
    await interaction.editReply({
      embeds: [successEmbed(`Giveaway #${giveaway.id} posted in ${channel}.\nPrize: **${prize}**`)],
    });
  });
}

async function handleAddEntry(interaction) {
  return runAction(interaction, async () => {
    const user = interaction.options.getUser('user', true);
    const hours = interaction.options.getNumber('hours', true);
    const seed = interaction.options.getNumber('seed', true);
    await addManualGiveawayEntry({
      client: interaction.client,
      userId: user.id,
      hours,
      seed,
      addedBy: interaction.user.id,
    });
    await interaction.editReply({
      embeds: [successEmbed(`Added/updated manual entry for ${user}: ${hours}h played, ${seed}h seed.`)],
    });
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
  return runAction(interaction, async () => {
    const channel = interaction.options.getChannel('channel');
    const { channel: posted, pages } = await openGiveawayVote({
      client: interaction.client,
      guild: interaction.guild,
      channel,
    });
    await interaction.editReply({
      embeds: [successEmbed(`Vote post opened in ${posted} (${pages} message${pages > 1 ? 's' : ''}).`)],
    });
  });
}

async function handleDraw(interaction) {
  return runAction(interaction, async () => {
    const { winner, channel } = await drawGiveaway({
      client: interaction.client,
      fallbackChannel: interaction.channel,
    });
    await interaction.editReply({
      embeds: [successEmbed(`Winner posted in ${channel}: <@${winner.userId}> with ${winner.tickets} tickets.`)],
    });
  });
}

async function handleCancel(interaction) {
  return runAction(interaction, async () => {
    const { giveaway } = await cancelActiveGiveaway({ client: interaction.client });
    await interaction.editReply({ embeds: [successEmbed(`Giveaway #${giveaway.id} cancelled.`)] });
  });
}
