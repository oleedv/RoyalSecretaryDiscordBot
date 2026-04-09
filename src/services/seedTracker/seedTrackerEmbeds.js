import { createEmbed } from '../../utils/embed.js';
import { formatDuration } from '../../utils/formatters.js';

const COLOR_SUCCESS = 0x57f287;
const COLOR_INFO = 0x5865f2;
const COLOR_WARNING = 0xfee75c;

function buildProgressBar(current, total, barLength = 20) {
  const filled = Math.min(Math.round((current / total) * barLength), barLength);
  const empty = barLength - filled;
  return `[${'#'.repeat(filled)}${'-'.repeat(empty)}] ${current}/${total} days`;
}

function formatQuality(avgQuality) {
  if (avgQuality == null) return 'N/A';
  return `${Math.round(avgQuality * 100)}%`;
}

function discordTimestamp(date, style = 'R') {
  const ts = Math.floor(new Date(date).getTime() / 1000);
  return `<t:${ts}:${style}>`;
}

export function buildProgressionEmbed(name, steamId, uniqueDays, required, streak, avgQuality) {
  const progress = buildProgressBar(uniqueDays, required);

  return createEmbed('Seed Tracker')
    .setColor(COLOR_INFO)
    .setTitle('Seed Progress')
    .setDescription(`**${name}**\n\`${progress}\``)
    .addFields(
      { name: 'Streak', value: `${streak} day${streak !== 1 ? 's' : ''}`, inline: true },
      { name: 'Quality', value: formatQuality(avgQuality), inline: true },
      { name: 'Steam ID', value: steamId, inline: false },
    );
}

export function buildMilestoneEmbed(name, milestone, uniqueDays) {
  const title = milestone === 5 ? 'Halfway There!' : 'Seeding Goal Reached!';

  return createEmbed('Seed Tracker')
    .setColor(COLOR_SUCCESS)
    .setTitle(title)
    .setDescription(`${name} has seeded ${uniqueDays} days!`);
}

export function buildWhitelistGrantedEmbed(name, steamId, expiresAt) {
  return createEmbed('Seed Tracker')
    .setColor(COLOR_SUCCESS)
    .setTitle('Whitelist Earned!')
    .setDescription(`${name} earned a 30-day whitelist for seeding!`)
    .addFields(
      { name: 'Steam ID', value: steamId, inline: true },
      { name: 'Expires', value: discordTimestamp(expiresAt), inline: true },
    );
}

export function buildLeaderboardEmbed(seeders, windowDays) {
  const lines = seeders.map((s, i) => {
    const rank = i + 1;
    const duration = formatDuration(s.totalDuration);
    const quality = formatQuality(s.avgQuality);
    return `**#${rank}** ${s.name} - ${s.seedDays} days | ${duration} | Quality: ${quality}`;
  });

  return createEmbed('Seed Tracker')
    .setColor(COLOR_INFO)
    .setTitle(`Top Seeders (${windowDays} Days)`)
    .setDescription(lines.join('\n') || 'No seeding data available.');
}

export function buildDmWhitelistNotification(name, expiresAt) {
  return createEmbed('Seed Tracker')
    .setColor(COLOR_SUCCESS)
    .setTitle('Whitelist Earned!')
    .setDescription(`Congratulations, ${name}! You earned a 30-day whitelist for helping seed Royal Battalion!`)
    .addFields(
      { name: 'Expires', value: discordTimestamp(expiresAt), inline: true },
    );
}

export function buildDmProgressionEmbed(stats, streak, whitelistStatus, requiredDays) {
  const progress = buildProgressBar(stats.uniqueDays, requiredDays);
  const duration = formatDuration(stats.totalDuration);
  const quality = formatQuality(stats.avgQuality);

  let wlStatus;
  if (whitelistStatus.hasWhitelist) {
    const expiry = whitelistStatus.expiresAt
      ? `Active (${whitelistStatus.role}) - expires ${discordTimestamp(whitelistStatus.expiresAt)}`
      : `Active (${whitelistStatus.role}) - no expiry`;
    wlStatus = expiry;
  } else {
    wlStatus = 'Not whitelisted';
  }

  return createEmbed('Seed Tracker')
    .setColor(COLOR_INFO)
    .setTitle('Your Seed Progression')
    .setDescription(`\`${progress}\``)
    .addFields(
      { name: 'Days', value: `${stats.uniqueDays}/${requiredDays}`, inline: true },
      { name: 'Streak', value: `${streak} day${streak !== 1 ? 's' : ''}`, inline: true },
      { name: 'Total Duration', value: duration, inline: true },
      { name: 'Avg Quality', value: quality, inline: true },
      { name: 'Whitelist Status', value: wlStatus, inline: false },
    );
}

export function buildExpiryWarningEmbed(name, daysRemaining, seedsNeeded) {
  return createEmbed('Seed Tracker')
    .setColor(COLOR_WARNING)
    .setTitle('Whitelist Expiring Soon')
    .setDescription(
      `${name}'s seed whitelist expires in ${daysRemaining} days. ${seedsNeeded} more seeds needed to renew.`
    );
}
