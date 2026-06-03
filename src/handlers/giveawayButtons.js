import { errorEmbed } from '../utils/embed.js';
import { getStoredSteamId } from '../services/userService.js';
import { getPlaytime } from '../services/playtimeService.js';
import {
  getGiveawayById,
  addLinkedEntry,
  countVotesForTarget,
  windowStartIso,
} from '../services/giveaway/giveawayService.js';
import { computeTickets } from '../services/giveaway/giveawayMath.js';
import { buildEnterConfirmEmbed } from '../services/giveaway/giveawayEmbeds.js';
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
