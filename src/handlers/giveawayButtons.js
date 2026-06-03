import { successEmbed, errorEmbed } from '../utils/embed.js';
import { getStoredSteamId } from '../services/userService.js';
import { getPlaytime } from '../services/playtimeService.js';
import {
  getGiveawayById,
  addLinkedEntry,
  countVotesForTarget,
  windowStartIso,
  castVote,
  countVotesByVoter,
} from '../services/giveaway/giveawayService.js';
import { computeTickets } from '../services/giveaway/giveawayMath.js';
import { buildEnterConfirmEmbed } from '../services/giveaway/giveawayEmbeds.js';
import config from '../config.js';
import logger from '../logger.js';

const log = logger.child({ module: 'giveawayButtons' });

export async function handleEnter(interaction) {
  const giveawayId = Number(interaction.customId.split(':')[1]);
  await interaction.deferReply({ flags: ['Ephemeral'] });

  const giveaway = await getGiveawayById(giveawayId);
  if (!giveaway || giveaway.status === 'cancelled' || giveaway.status === 'drawn') {
    return interaction.editReply({ embeds: [errorEmbed('This giveaway is no longer accepting entries.')] });
  }

  const steamId = await getStoredSteamId(interaction.user.id);
  if (!steamId) {
    return interaction.editReply({
      embeds: [errorEmbed('You need to link your Steam account first using the verify panel.')],
    });
  }

  const live = await getPlaytime(steamId, windowStartIso(giveaway.window_days)).catch((err) => {
    log.warn({ err, userId: interaction.user.id, steamId }, 'getPlaytime failed');
    return null;
  });

  if (!live || live.playtimeHours < Number(giveaway.min_hours)) {
    return interaction.editReply({
      embeds: [errorEmbed(
        `You need at least ${Number(giveaway.min_hours)}h played on RB in the last ${giveaway.window_days} days. `
        + `You have ${live?.playtimeHours ?? 0}h.`
      )],
    });
  }

  await addLinkedEntry(giveaway.id, interaction.user.id, steamId);

  const votes = await countVotesForTarget(giveaway.id, interaction.user.id);
  const tickets = computeTickets(
    { manualHours: null, manualSeed: null, steamId },
    live,
    votes,
    { hours: Number(giveaway.hours_weight), seed: Number(giveaway.seed_weight), vote: Number(giveaway.vote_weight) }
  );

  await interaction.editReply({
    embeds: [buildEnterConfirmEmbed(tickets, live.playtimeHours, live.seedHours)],
  });
}

export async function handleVote(interaction) {
  const [, giveawayIdStr, targetId] = interaction.customId.split(':');
  const giveawayId = Number(giveawayIdStr);
  await interaction.deferReply({ flags: ['Ephemeral'] });

  const memberRoleId = config.prospects?.memberRoleId;
  if (memberRoleId && !interaction.member?.roles?.cache?.has(memberRoleId)) {
    return interaction.editReply({ embeds: [errorEmbed('Voting is restricted to RB members.')] });
  }

  const giveaway = await getGiveawayById(giveawayId);
  if (!giveaway || giveaway.status !== 'voting') {
    return interaction.editReply({ embeds: [errorEmbed('Voting is closed.')] });
  }

  const result = await castVote(giveaway, interaction.user.id, targetId);
  if (!result.ok) {
    const msg = {
      cap: `You've used all ${giveaway.votes_per_voter} of your votes.`,
      duplicate: 'You already voted for this entrant.',
      self: 'You cannot vote for yourself.',
    }[result.reason] || 'Vote failed.';
    return interaction.editReply({ embeds: [errorEmbed(msg)] });
  }

  const usedAfter = await countVotesByVoter(giveaway.id, interaction.user.id);
  const remaining = giveaway.votes_per_voter - usedAfter;

  await interaction.editReply({
    embeds: [successEmbed(`Vote recorded for <@${targetId}>. You have ${remaining} vote(s) left.`)],
  });
}
