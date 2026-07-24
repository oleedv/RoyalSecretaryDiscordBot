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

/** Matches the " · updated <t:…:R>" suffix on call embeds (for signature compare). */
export const CALL_UPDATED_SUFFIX_RE = /\s*·\s*updated <t:\d+:R>/g;

/**
 * Live call embed while a seeding session is active.
 * @param {object} opts
 * @param {number|null} [opts.updatedAt] Unix seconds for the relative "updated" line (default: now)
 */
export function buildSeedingCallEmbed({
  layerName, playerCount, threshold, thumbnailUrl,
  avgSeedTime, avgSeedTrend,
  gameMode, fastestSeed,
  updatedAt,
}) {
  const updatedTs = updatedAt ?? Math.floor(Date.now() / 1000);
  const updatedSuffix = ` · updated <t:${updatedTs}:R>`;
  const populationLine = playerCount == null
    ? `\`Population: unavailable\`${updatedSuffix}`
    : `\`${playerCount} / ${threshold} players\`${updatedSuffix}`;

  const embed = createEmbed('Seeding')
    .setTitle('Seeding Time!')
    .setDescription(
      'Join the server and help us get live!\n' +
      `Target: **${threshold}** players\n\n` +
      populationLine
    )
    .setColor(0x57f287);

  // Row 1: Map info
  const row1 = [];
  row1.push({ name: 'Current Map', value: layerName || 'Unknown', inline: true });
  if (gameMode) row1.push({ name: 'Game Mode', value: gameMode, inline: true });
  if (row1.length) embed.addFields(...row1);

  // Row 2: Timing stats (hide 0-minute fastest — usually a flaky session, not a real record)
  const row2 = [];
  if (avgSeedTime) {
    const arrow = trendArrows[avgSeedTrend] || '';
    row2.push({ name: 'Avg Seed Time', value: arrow ? `~${avgSeedTime} min ${arrow}` : `~${avgSeedTime} min`, inline: true });
  }
  if (fastestSeed != null && fastestSeed > 0) {
    row2.push({ name: 'Fastest Seed', value: `${fastestSeed} min`, inline: true });
  }
  if (row2.length) embed.addFields(...row2);

  if (thumbnailUrl) {
    embed.setImage(thumbnailUrl);
  }

  return embed;
}

export function buildSeedingRapportEmbed({ date, totalSeeders, totalJoins, avgSeedMinutes, totalSeedMinutes, seeders }) {
  const dateLabel = new Date(date + 'T12:00:00Z').toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });

  const embed = createEmbed('Seeding')
    .setTitle(`Seeding Rapport - ${dateLabel}`)
    .setColor(0x57f287);

  embed.addFields(
    { name: 'Total Seeders', value: String(totalSeeders || 0), inline: true },
    { name: 'Total Joins', value: String(totalJoins || 0), inline: true },
    { name: 'Avg Seed Time', value: avgSeedMinutes ? `${avgSeedMinutes} min` : '--', inline: true },
  );

  if (seeders && seeders.length > 0) {
    // Show top 15 seeders by seed duration
    const top = seeders.slice(0, 15);
    const lines = top.map((s, i) => {
      const dur = s.seedDurationMinutes != null ? `${s.seedDurationMinutes}m` : '--';
      return `**${i + 1}.** ${s.playerName} - ${dur}`;
    });
    embed.addFields({ name: 'Top Seeders', value: lines.join('\n') || 'No data', inline: false });

    if (seeders.length > 15) {
      embed.setFooter({ text: `+${seeders.length - 15} more seeders not shown` });
    }
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
