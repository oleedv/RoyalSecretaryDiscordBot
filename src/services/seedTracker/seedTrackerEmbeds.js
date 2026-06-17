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

const TRACK_GLYPH = {
  doneDay: '⬤', remainDay: '◯',
  doneHalf: '⬥', remainHalf: '⬦',
  doneGoal: '⨀', remainGoal: '⊙',
};

/**
 * Render a milestone track: one node per required seed day, joined by `━━`.
 * The halfway node (floor(total/2)) and the final goal node are distinct
 * checkpoints that fill once reached. `done` is clamped to [0, total].
 */
export function buildMilestoneTrack(done, total) {
  const filled = Math.max(0, Math.min(done, total));
  const halfwayIdx = Math.floor(total / 2);
  const nodes = [];
  for (let i = 1; i <= total; i++) {
    const reached = i <= filled;
    let glyph;
    if (i === total) glyph = reached ? TRACK_GLYPH.doneGoal : TRACK_GLYPH.remainGoal;
    else if (i === halfwayIdx) glyph = reached ? TRACK_GLYPH.doneHalf : TRACK_GLYPH.remainHalf;
    else glyph = reached ? TRACK_GLYPH.doneDay : TRACK_GLYPH.remainDay;
    nodes.push(glyph);
  }
  return nodes.join('━━');
}

function formatQuality(avgQuality) {
  if (avgQuality == null) return 'N/A';
  return `${Math.round(avgQuality * 100)}%`;
}

function discordTimestamp(date, style = 'R') {
  const ts = Math.floor(new Date(date).getTime() / 1000);
  return `<t:${ts}:${style}>`;
}

export function buildProgressionEmbed({ name, steamId, uniqueDays, required, streak, avatarUrl = null, seedAgainBy = null }) {
  const done = Math.max(0, Math.min(uniqueDays, required));
  const track = buildMilestoneTrack(uniqueDays, required);

  const embed = createEmbed('Seed Tracker')
    .setColor(COLOR_INFO)
    .setTitle('Seed Progress')
    .setDescription(`**${name}**\n\`${track}\`\n**${done} / ${required} days**`);

  if (avatarUrl) embed.setThumbnail(avatarUrl);

  const fields = [
    { name: 'Streak', value: `${streak} day${streak !== 1 ? 's' : ''}`, inline: true },
  ];
  if (seedAgainBy) {
    fields.push({ name: 'Resets', value: discordTimestamp(seedAgainBy, 'R'), inline: true });
  }
  fields.push({ name: 'Steam ID', value: steamId, inline: false });
  embed.addFields(...fields);

  return embed;
}

export function buildMilestoneEmbed(name, milestone, uniqueDays) {
  const title = milestone === 5 ? 'Halfway There!' : 'Seeding Goal Reached!';

  return createEmbed('Seed Tracker')
    .setColor(COLOR_SUCCESS)
    .setTitle(title)
    .setDescription(`${name} has seeded ${uniqueDays} days!`);
}

export function buildWhitelistGrantedEmbed(name, steamId, expiresAt, durationDays = 30) {
  return createEmbed('Seed Tracker')
    .setColor(COLOR_SUCCESS)
    .setTitle('Whitelist Earned!')
    .setDescription(`${name} earned a ${durationDays}-day whitelist for seeding!`)
    .addFields(
      { name: 'Steam ID', value: steamId, inline: true },
      { name: 'Expires', value: discordTimestamp(expiresAt), inline: true },
    );
}

export function buildLeaderboardEmbed(seeders, windowDays) {
  const lines = seeders.map((s, i) => {
    const rank = i + 1;
    const duration = formatDuration(s.totalDuration);
    return `**#${rank}** ${s.name} - ${s.seedDays} days | ${duration}`;
  });

  return createEmbed('Seed Tracker')
    .setColor(COLOR_INFO)
    .setTitle(`Top Seeders (${windowDays} Days)`)
    .setDescription(lines.join('\n') || 'No seeding data available.');
}

export function buildDmWhitelistNotification(name, expiresAt, durationDays = 30) {
  return createEmbed('Seed Tracker')
    .setColor(COLOR_SUCCESS)
    .setTitle('Whitelist Earned!')
    .setDescription(`Congratulations, ${name}! You earned a ${durationDays}-day whitelist for helping seed Royal Battalion!`)
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
