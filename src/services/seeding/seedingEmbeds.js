import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createEmbed } from '../../utils/embed.js';

const trendArrows = { up: '\u2191', down: '\u2193', stable: '\u2192' };

export function getLayerImageUrl(layerObj, layerName) {
  const BASE = 'https://raw.githubusercontent.com/Squad-Wiki/squad-wiki-pipeline-map-data/master/completed_output/_Current%20Version/images';
  if (layerObj?.layerid) return `${BASE}/${layerObj.layerid}.jpg`;
  if (layerName) return `${BASE}/${layerName.replace(/\s+/g, '_')}.jpg`;
  return null;
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

/**
 * Persistent panel embed - always visible in the seeding channel.
 * @param {number|null} seederCount  Current role member count
 * @param {number}      dailyTs     Unix timestamp of today's seeding start time
 * @param {number}      threshold   Player target
 */
export function buildSeedingPanelMessage(seederCount, dailyTs, threshold) {
  const embed = createEmbed('Seeding')
    .setTitle('Royal Battalion Seeding')
    .setDescription(
      'Join our seeding team! We count on our amazing members, prospects, ' +
      'external partners, and whitelisted community to help seed the server regularly.\n\n' +
      `Seeding starts at <t:${dailyTs}:t> every day. (<t:${dailyTs}:R>)\n\n` +
      '**How to Help**\n' +
      '- Join the server when seeding begins\n' +
      `- Stay until ${threshold}+ players\n` +
      '- Invite friends!\n\n' +
      '**Benefits**\n' +
      '- Get notified when seeding begins\n' +
      '- Work towards getting whitelisted by seeding 10x within 30 days\n' +
      '- Help build our amazing community!'
    )
    .setColor(0x57f287);

  const components = buildSeederRoleComponents(seederCount);
  return { embeds: [embed], components };
}

export function buildSeedingCallEmbed({
  layerName, playerCount, threshold, thumbnailUrl,
  avgSeedTime, avgSeedTrend,
  serverName, gameMode, fastestSeed,
}) {
  const embed = createEmbed('Seeding')
    .setTitle('Seeding Time!')
    .setDescription(
      'Join the server and help us get live!\n' +
      `Target: **${threshold}** players\n\n` +
      `\`${playerCount} / ${threshold} players\``
    )
    .setColor(0x57f287);

  // Row 1: Server info
  const row1 = [];
  if (serverName) row1.push({ name: 'Server', value: serverName, inline: true });
  row1.push({ name: 'Current Map', value: layerName || 'Unknown', inline: true });
  if (gameMode) row1.push({ name: 'Game Mode', value: gameMode, inline: true });
  if (row1.length) embed.addFields(...row1);

  // Row 2: Timing stats
  const row2 = [];
  if (avgSeedTime) {
    const arrow = trendArrows[avgSeedTrend] || '';
    row2.push({ name: 'Avg Seed Time', value: arrow ? `~${avgSeedTime} min ${arrow}` : `~${avgSeedTime} min`, inline: true });
  }
  if (fastestSeed != null) {
    row2.push({ name: 'Fastest Seed', value: `${fastestSeed} min`, inline: true });
  }
  if (row2.length) embed.addFields(...row2);

  // Last updated timestamp
  const now = Math.floor(Date.now() / 1000);
  embed.addFields({ name: '\u200b', value: `Last updated <t:${now}:R>`, inline: false });

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
