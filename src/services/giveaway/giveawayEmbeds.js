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
    .setTitle(`RB Member Game Giveaway: ${giveaway.month_label}`)
    .setDescription(lines.join('\n'))
    .setColor(COLOR_GIVEAWAY);

  if (topPlayed.length) {
    embed.addFields({
      name: 'Top Played',
      value: topPlayed.map((r, i) => `${i + 1}. <@${r.userId}> · ${r.hours}h`).join('\n') || '*(none yet)*',
      inline: true,
    });
  }
  if (topSeed.length) {
    embed.addFields({
      name: 'Top Seeding',
      value: topSeed.map((r, i) => `${i + 1}. <@${r.userId}> · ${r.seed}h`).join('\n') || '*(none yet)*',
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

export const VOTE_BUTTONS_PER_MESSAGE = 25;
const BUTTONS_PER_ROW = 5;

export function buildVoteEmbed(giveaway, page, totalPages) {
  const pageSuffix = totalPages > 1 ? ` (page ${page + 1}/${totalPages})` : '';
  return new EmbedBuilder()
    .setTitle(`Community Vote: ${giveaway.month_label}${pageSuffix}`)
    .setDescription([
      `**Who has gone above and beyond for the community this month?**`,
      '',
      `You can vote for up to **${giveaway.votes_per_voter}** different entrants.`,
      `Each vote adds **+${Number(giveaway.vote_weight)}** raffle ticket for that person.`,
      'You cannot vote for the same person twice.',
    ].join('\n'))
    .setColor(COLOR_INFO);
}

/**
 * Returns an array of message payloads (one per page) for the vote post.
 * entries: [{ userId, displayName }]
 */
export function buildVoteMessages(giveaway, entries) {
  const pages = [];
  for (let i = 0; i < entries.length; i += VOTE_BUTTONS_PER_MESSAGE) {
    pages.push(entries.slice(i, i + VOTE_BUTTONS_PER_MESSAGE));
  }
  if (pages.length === 0) pages.push([]);

  return pages.map((pageEntries, pageIdx) => {
    const rows = [];
    for (let i = 0; i < pageEntries.length; i += BUTTONS_PER_ROW) {
      const row = new ActionRowBuilder();
      for (const entry of pageEntries.slice(i, i + BUTTONS_PER_ROW)) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`giveaway_vote:${giveaway.id}:${entry.userId}`)
            .setLabel(truncate(entry.displayName, 80))
            .setStyle(ButtonStyle.Secondary)
        );
      }
      rows.push(row);
    }
    return {
      embeds: [buildVoteEmbed(giveaway, pageIdx, pages.length)],
      components: rows,
    };
  });
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function buildLeaderboardEmbed(giveaway, leaderboard, limit = 20) {
  const top = leaderboard.slice(0, limit);
  const lines = top.map((r, i) => {
    const tag = r.manual ? ' *(manual)*' : '';
    return `\`${String(i + 1).padStart(2, ' ')}.\` <@${r.userId}> · **${r.tickets}** tickets `
      + `(${r.hours}h + 2×${r.seed}h seed + ${r.votes} votes)${tag}`;
  });
  return new EmbedBuilder()
    .setTitle(`Leaderboard: ${giveaway.month_label}`)
    .setDescription(lines.length ? lines.join('\n') : '*No entries yet.*')
    .setColor(COLOR_INFO)
    .setFooter({ text: `Total entries: ${leaderboard.length}` });
}

export function buildWinnerEmbed(giveaway, winner, leaderboard) {
  const total = leaderboard.reduce((s, e) => s + e.tickets, 0);
  const top5 = leaderboard.slice(0, 5);
  const breakdown = top5.map((r, i) =>
    `${i + 1}. <@${r.userId}> · ${r.tickets} tickets`
  ).join('\n');

  return new EmbedBuilder()
    .setTitle(`Winner: ${giveaway.month_label}`)
    .setDescription([
      `Prize: **${giveaway.prize}**`,
      '',
      `Winner: <@${winner.userId}>`,
      `Tickets: **${winner.tickets}** of ${total}`,
      `Entries: **${leaderboard.length}**`,
      '',
      '**Top 5:**',
      breakdown || '*(only one entrant)*',
    ].join('\n'))
    .setColor(COLOR_WINNER);
}

export function buildEnterConfirmEmbed(tickets, hours, seed) {
  return new EmbedBuilder()
    .setTitle('Entered!')
    .setDescription(
      `You currently have **${tickets}** tickets `
      + `(${hours}h played + 2×${seed}h seeding).\n`
      + 'Vote post opens later this month.'
    )
    .setColor(COLOR_WINNER);
}
