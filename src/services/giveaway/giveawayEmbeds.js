import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

const COLOR_GIVEAWAY = 0xFFD700;
const COLOR_WINNER = 0x57F287;
const COLOR_INFO = 0x5865F2;

export function buildEntryEmbed(giveaway, entryCount, topPlayed = [], topSeed = []) {
  const lines = [
    `**Prize:** ${giveaway.prize}`,
    '',
    'Earn raffle tickets by playing on RB:',
    `- **${Number(giveaway.hours_weight)}** ticket per hour played`,
    `- **+${Number(giveaway.seed_weight)}** tickets per hour seeding`,
    `- **+${Number(giveaway.vote_weight)}** ticket per community vote (RB only)`,
    '',
    `Minimum to enter: **${Number(giveaway.min_hours)}h** played in the last ${giveaway.window_days} days.`,
    `Draw: <t:${Math.floor(new Date(giveaway.draw_at).getTime() / 1000)}:F>`,
    '',
    `Entries so far: **${entryCount}**`,
  ];

  const embed = new EmbedBuilder()
    .setTitle(`RB Member Game Giveaway — ${giveaway.month_label}`)
    .setDescription(lines.join('\n'))
    .setColor(COLOR_GIVEAWAY);

  if (topPlayed.length) {
    embed.addFields({
      name: 'Top Played',
      value: topPlayed.map((r, i) => `${i + 1}. <@${r.userId}> — ${r.hours}h`).join('\n') || '*(none yet)*',
      inline: true,
    });
  }
  if (topSeed.length) {
    embed.addFields({
      name: 'Top Seeding',
      value: topSeed.map((r, i) => `${i + 1}. <@${r.userId}> — ${r.seed}h`).join('\n') || '*(none yet)*',
      inline: true,
    });
  }

  return embed;
}

export function buildEntryRow(giveawayId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`giveaway_enter:${giveawayId}`)
      .setLabel('Enter Giveaway')
      .setStyle(ButtonStyle.Primary)
      .setEmoji({ name: '🎟' })
  );
}
