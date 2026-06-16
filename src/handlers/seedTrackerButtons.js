import { getStoredSteamId } from '../services/userService.js';
import { getPlayerSeedStats, getSeedStreak, getSeederWhitelist } from '../services/seedTracker/seedTrackerService.js';
import { getSeedingConfig } from '../services/seeding/seedingService.js';
import { buildDmProgressionEmbed } from '../services/seedTracker/seedTrackerEmbeds.js';
import { errorEmbed } from '../utils/embed.js';
import logger from '../logger.js';

const log = logger.child({ module: 'seedTrackerButtons' });

export async function handleSeedProgression(interaction) {
  await interaction.deferReply({ flags: ['Ephemeral'] });

  const steamId = await getStoredSteamId(interaction.user.id);
  if (!steamId) {
    return interaction.editReply({
      embeds: [errorEmbed('No Steam ID linked. Please verify your account first.')],
    });
  }

  try {
    const cfg = await getSeedingConfig();
    const windowDays = cfg?.rolling_window_days || 30;
    const requiredDays = cfg?.required_seed_days || 10;
    const serverId = cfg?.tracker_server_id ?? null;

    const [stats, streak, whitelist] = await Promise.all([
      getPlayerSeedStats(steamId, windowDays, serverId),
      getSeedStreak(steamId, serverId),
      getSeederWhitelist(steamId),
    ]);

    const whitelistStatus = whitelist
      ? { hasWhitelist: true, role: whitelist.role, expiresAt: whitelist.expiresAt }
      : { hasWhitelist: false, role: null, expiresAt: null };

    const embed = buildDmProgressionEmbed(stats, streak, whitelistStatus, requiredDays);
    return interaction.editReply({ embeds: [embed] });
  } catch (err) {
    log.error({ err, userId: interaction.user.id }, 'Failed to fetch seed progression');
    return interaction.editReply({
      embeds: [errorEmbed('Failed to fetch your seed progression. Please try again later.')],
    });
  }
}
