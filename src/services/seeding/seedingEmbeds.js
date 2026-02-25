import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import sharp from 'sharp';
import { createEmbed } from '../../utils/embed.js';
import logger from '../../logger.js';

const log = logger.child({ module: 'seedingEmbeds' });
const cropCache = new Map();
const MAX_CROP_CACHE = 20;

const trendArrows = { up: '\u2191', down: '\u2193', stable: '\u2192' };

function buildProgressBar(current, total, length = 10) {
  const clamped = Math.min(Math.max(current, 0), total);
  const filled = Math.round((clamped / total) * length);
  const empty = length - filled;
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
  const pct = Math.round((clamped / total) * 100);
  return `${bar} ${pct}%`;
}

export function buildSeedingCallEmbed({
  mapName, playerCount, threshold, thumbnailUrl, imageAttachment,
  avgSeedTime, avgSeedTrend,
  serverName, gameMode, successRate, fastestSeed, totalCompleted,
  lastCompletedAt,
}) {
  const progressBar = buildProgressBar(playerCount, threshold);

  const embed = createEmbed('Seeding')
    .setTitle('Seeding Time!')
    .setDescription(
      'Join the server and help us fill it up!\n' +
      `Target: **${threshold}** players\n\n` +
      `**${progressBar}**\n` +
      `\`${playerCount} / ${threshold} players\``
    )
    .setColor(0xfee75c);

  // Row 1: Server info
  const row1 = [];
  if (serverName) row1.push({ name: 'Server', value: serverName, inline: true });
  row1.push({ name: 'Current Map', value: mapName || 'Unknown', inline: true });
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
  if (successRate != null) {
    row2.push({ name: 'Success Rate', value: `${successRate}%`, inline: true });
  }
  if (row2.length) embed.addFields(...row2);

  // Row 3: Historical context
  const row3 = [];
  if (totalCompleted != null && totalCompleted > 0) {
    row3.push({ name: 'Seeds (30d)', value: String(totalCompleted), inline: true });
  }
  if (lastCompletedAt) {
    const ts = Math.floor(new Date(lastCompletedAt).getTime() / 1000);
    row3.push({ name: 'Last Seeded', value: `<t:${ts}:R>`, inline: true });
  }
  if (row3.length) embed.addFields(...row3);

  // Last updated timestamp (matches server status pattern)
  const now = Math.floor(Date.now() / 1000);
  embed.addFields({ name: '\u200b', value: `Last updated <t:${now}:R>`, inline: false });

  if (imageAttachment) {
    embed.setImage(`attachment://${imageAttachment}`);
  } else if (thumbnailUrl) {
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

export async function cropMapThumbnail(url) {
  if (!url) return null;
  if (cropCache.has(url)) return cropCache.get(url);

  try {
    const res = await fetch(url);
    if (!res.ok) return null;

    const buf = Buffer.from(await res.arrayBuffer());
    const meta = await sharp(buf).metadata();
    const cropW = Math.round(meta.width * 0.5);
    const cropH = Math.round(meta.height * 0.5);
    const left = Math.round(meta.width * 0.25);
    const top = Math.round(meta.height * 0.25);

    const cropped = await sharp(buf)
      .extract({ left, top, width: cropW, height: cropH })
      .jpeg({ quality: 85 })
      .toBuffer();

    if (cropCache.size >= MAX_CROP_CACHE) {
      const oldest = cropCache.keys().next().value;
      cropCache.delete(oldest);
    }
    cropCache.set(url, cropped);
    return cropped;
  } catch (err) {
    log.warn({ err, url }, 'Failed to crop map thumbnail');
    return null;
  }
}
