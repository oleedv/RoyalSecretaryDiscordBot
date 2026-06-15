import { getStoredSteamId } from '../services/userService.js';
import { getPlayerSeedStats, getSeedStreak, getSeederWhitelist } from '../services/seedTracker/seedTrackerService.js';
import { buildDmProgressionEmbed } from '../services/seedTracker/seedTrackerEmbeds.js';
import { errorEmbed } from '../utils/embed.js';
import config from '../config.js';
import logger from '../logger.js';

const log = logger.child({ module: 'seedTrackerButtons' });

export async function handleSeedProgression(interaction) {
  await interaction.deferReply({ flags: ['Ephemeral'] });

  const steamId = await getStoredSteamId(interaction.user.id);
  if (!steamId) {
    return interaction.editReply({
      embeds: [errorEmbed('No Steam ID linked. **DM me and click Link Steam** to connect your account.')],
    });
  }

  try {
    const [stats, streak, whitelist] = await Promise.all([
      getPlayerSeedStats(steamId, config.seedTracker?.rollingWindowDays || 30),
      getSeedStreak(steamId),
      getSeederWhitelist(steamId),
    ]);

    const whitelistStatus = whitelist
      ? { hasWhitelist: true, role: whitelist.role, expiresAt: whitelist.expiresAt }
      : { hasWhitelist: false, role: null, expiresAt: null };

    const embed = buildDmProgressionEmbed(stats, streak, whitelistStatus, config.seedTracker?.requiredSeedDays || 10);
    return interaction.editReply({ embeds: [embed] });
  } catch (err) {
    log.error({ err, userId: interaction.user.id }, 'Failed to fetch seed progression');
    return interaction.editReply({
      embeds: [errorEmbed('Failed to fetch your seed progression. Please try again later.')],
    });
  }
}
