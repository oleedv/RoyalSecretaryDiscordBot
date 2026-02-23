import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createEmbed } from '../../utils/embed.js';

export function buildSeedingCallEmbed({ mapName, layerName, playerCount, threshold, thumbnailUrl, avgSeedTime, serverName }) {
  const embed = createEmbed('Seeding')
    .setTitle('Seeding Time!')
    .setDescription(
      'The server needs seeders! Join now and help us get the server populated.\n\n' +
      'Every seeder makes a difference — hop in, grab a squad, and hold the line until we hit capacity.'
    )
    .setColor(0xfee75c)
    .addFields(
      { name: 'Server', value: serverName || 'Royal Battalion', inline: true },
      { name: 'Current Map', value: mapName || 'Unknown', inline: true },
      { name: 'Players', value: `${playerCount} / ${threshold} needed`, inline: true },
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
      'The server has reached the seeding threshold. Thanks to everyone who helped seed!\n\n' +
      'Time to switch to your regular gameplay. See you on the battlefield!'
    )
    .setColor(0x57f287);

  const fields = [];
  if (mapName) fields.push({ name: 'Map', value: mapName, inline: true });
  if (playerCount) fields.push({ name: 'Players', value: String(playerCount), inline: true });
  if (duration != null) fields.push({ name: 'Time to Seed', value: `${duration} min`, inline: true });
  if (fields.length > 0) embed.addFields(...fields);

  return embed;
}

export function buildSeederRoleComponents() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('seeding_join')
      .setLabel('Join Seeders')
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
