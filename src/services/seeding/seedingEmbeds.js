import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createEmbed } from '../../utils/embed.js';

export function buildSeedingCallEmbed({ mapName, playerCount, threshold, thumbnailUrl, avgSeedTime }) {
  const embed = createEmbed('Seeding')
    .setTitle('Seeding Time!')
    .setDescription(
      'Join the server now and help us get the population up!\n' +
      `Stay until we reach ${threshold}+ players for the best experience.\n` +
      'Every volunteer makes a difference!'
    )
    .setColor(0xfee75c)
    .addFields(
      { name: 'Current Map', value: mapName || 'Unknown', inline: true },
      { name: 'Players', value: `${playerCount} / ${threshold}`, inline: true },
    );

  if (avgSeedTime) {
    embed.addFields({ name: 'Avg Seed Time', value: `~${avgSeedTime} min`, inline: true });
  }

  if (thumbnailUrl) {
    embed.setImage(thumbnailUrl);
  }

  return embed;
}

export function buildSeedingCompletionEmbed({ mapName, playerCount, duration }) {
  const embed = createEmbed('Seeding')
    .setTitle('Server Fully Seeded!')
    .setDescription(
      'Amazing work, seeders! The server is now populated and ready for action!\n\n' +
      'Time to switch from seeding to playing!\n' +
      'Join the server now for the best Squad experience!\n' +
      'Thanks to all our dedicated seeders who made this possible!\n\n' +
      '**What\'s Next?**\n' +
      '- Join the server and enjoy the populated gameplay!\n' +
      '- Continue playing to keep the momentum going!\n' +
      '- Great work!'
    )
    .setColor(0x57f287);

  const fields = [];
  if (mapName) fields.push({ name: 'Map', value: mapName, inline: true });
  if (playerCount) fields.push({ name: 'Players', value: String(playerCount), inline: true });
  if (duration != null) fields.push({ name: 'Time to Seed', value: `${duration} min`, inline: true });
  if (fields.length > 0) embed.addFields(...fields);

  return embed;
}

export function buildSeederRoleComponents(seederCount = null) {
  const joinLabel = seederCount != null ? `Join Seeders (${seederCount})` : 'Join Seeders';
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('seeding_join')
      .setLabel(joinLabel)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('seeding_leave')
      .setLabel('Leave Seeders')
      .setStyle(ButtonStyle.Danger),
  );
  return [row];
}

export function getMapThumbnailUrl(layerName) {
  if (!layerName) return null;
  // SquadJS layer format: "Al Basrah AAS v1"
  // GitHub filename format: "AlBasrah_AAS_v1.jpg"
  const normalized = layerName
    .replace(/\s+/g, '_')
    .replace(/__+/g, '_');
  return `https://raw.githubusercontent.com/mahtoid/SquadMaps/master/img/maps/thumbnails/${normalized}.jpg`;
}
