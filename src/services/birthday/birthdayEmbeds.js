import { createEmbed } from '../../utils/embed.js';

const GOLD = 0xffd700;

// Gold birthday embed. `age` is included only when showAge is true. Text-only copy
// (no emojis) per the project style rule; createEmbed() adds the footer + timestamp.
export function buildBirthdayEmbed({ displayName, avatarUrl, showAge, age }) {
  const name = displayName || 'Royal Battalion member';
  const embed = createEmbed('Birthday').setColor(GOLD).setTitle(`Happy Birthday, ${name}!`);

  const lines = [`The Royal Battalion wishes ${name} a fantastic birthday.`];
  if (showAge && Number.isFinite(age)) {
    lines.push(`Celebrating ${age} years today.`);
  }
  lines.push('Drop a message and help us celebrate.');
  embed.setDescription(lines.join('\n'));

  if (avatarUrl) embed.setThumbnail(avatarUrl);
  return embed;
}
