import { createEmbed } from '../../utils/embed.js';

const COLOR_SUCCESS = 0x57f287;
const COLOR_INFO = 0x5865f2;
const COLOR_MUTED = 0x99aab5;

function steamField(steamId) {
  // Same Steam-profile link standard used by the prospect/ticket embeds.
  return `\`${steamId}\` · [steamid.com](https://www.steamid.com/profiles/${steamId})`;
}

function relativeTimestamp(date) {
  return `<t:${Math.floor(new Date(date).getTime() / 1000)}:R>`;
}

function playerValue(name, discordId) {
  const safeName = name || 'Unknown';
  return discordId ? `${safeName} (<@${discordId}>)` : safeName;
}

export function buildGrantLogEmbed({ name, steamId, discordId, hours, days, expiresAt, dry }) {
  return createEmbed('SL Reward')
    .setColor(dry ? COLOR_MUTED : COLOR_SUCCESS)
    .setTitle(dry ? 'Would grant SL whitelist' : 'SL whitelist granted')
    .addFields(
      { name: 'Player', value: playerValue(name, discordId), inline: true },
      { name: 'Qualifying', value: `${hours.toFixed(1)}h / 5.0h`, inline: true },
      {
        name: 'Reward',
        value: dry ? `${days} days (dry-run)` : `${days} days, expires ${relativeTimestamp(expiresAt)}`,
        inline: false
      },
      { name: 'Steam', value: steamField(steamId), inline: false }
    );
}

export function buildExtendLogEmbed({ name, steamId, discordId, hours, days, dry }) {
  return createEmbed('SL Reward')
    .setColor(dry ? COLOR_MUTED : COLOR_INFO)
    .setTitle(dry ? 'Would extend SL whitelist' : 'SL whitelist extended')
    .addFields(
      { name: 'Player', value: playerValue(name, discordId), inline: true },
      { name: 'Qualifying', value: `${hours.toFixed(1)}h / 5.0h`, inline: true },
      { name: 'Added', value: `${days} days`, inline: true },
      { name: 'Steam', value: steamField(steamId), inline: false }
    );
}

export function buildRunSummaryEmbed({ candidates, grants, extensions, skips, dmsQueued, dmsRedelivered, dry }) {
  const skipText =
    Object.entries(skips)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n') || 'none';

  const embed = createEmbed('SL Reward')
    .setColor(grants || extensions ? COLOR_SUCCESS : COLOR_INFO)
    .setTitle(`SL grant cron run${dry ? ' (dry-run)' : ''}`)
    .addFields(
      { name: 'Candidates', value: String(candidates), inline: true },
      { name: 'Granted', value: String(grants), inline: true },
      { name: 'Extended', value: String(extensions), inline: true },
      { name: 'Skipped', value: skipText, inline: false }
    );

  if (dmsQueued || dmsRedelivered) {
    embed.addFields({
      name: 'DMs',
      value: `queued ${dmsQueued} · redelivered ${dmsRedelivered}`,
      inline: false
    });
  }
  return embed;
}
