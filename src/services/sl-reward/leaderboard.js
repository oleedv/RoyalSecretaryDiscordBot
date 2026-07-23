import { EmbedBuilder } from 'discord.js';

const NAME_WIDTH = 24;

/**
 * Pure: join the SquadJS top rows with webpage User records and active WhitelistEntry
 * rows into display-ready leaderboard rows.
 */
export function buildLeaderboardRows({ topRows, users, whitelist, slClanId }) {
  const userBySteam = new Map((users ?? []).map((u) => [u.steamId, u]));
  const wlBySteam = new Map();
  for (const w of whitelist ?? []) {
    if (!wlBySteam.has(w.steamId)) wlBySteam.set(w.steamId, []);
    wlBySteam.get(w.steamId).push(w);
  }
  return topRows.map((r, i) => {
    const entries = wlBySteam.get(r.steam_id) ?? [];
    let badge = '-';
    if (entries.some((e) => e.clanId === slClanId)) badge = '✓ SL';
    else if (entries.length > 0) badge = '✓';
    const user = userBySteam.get(r.steam_id);
    return {
      rank: i + 1,
      displayName: user?.discordName ?? r.in_game_name ?? 'Unknown',
      hours: Number(r.hours).toFixed(1),
      badge
    };
  });
}

/**
 * Pure: render display rows as a fixed-width code-block table for the embed body.
 */
export function formatLeaderboardTable(rows) {
  if (!rows || rows.length === 0) return 'No qualifying SL time in the last 7 days.';
  const lines = rows.map((r) => {
    const name =
      r.displayName.length > NAME_WIDTH
        ? r.displayName.slice(0, NAME_WIDTH - 1) + '…'
        : r.displayName;
    return `${String(r.rank).padStart(2)}. ${name.padEnd(NAME_WIDTH)} ${String(r.hours).padStart(
      5
    )}h  ${r.badge}`;
  });
  return '```\n' + lines.join('\n') + '\n```';
}

/**
 * Build the leaderboard embed for send/edit.
 */
export function buildLeaderboardEmbed({ rows, nextUpdateUnix }) {
  const embed = new EmbedBuilder()
    .setTitle('Squad Leader Rankings (rolling 7 days)')
    .setDescription('Top squad leaders by qualifying SL time. Reach 5h to earn 7 days of free whitelist.')
    .addFields({ name: '​', value: formatLeaderboardTable(rows) })
    .setColor(0x2ecc71);
  if (nextUpdateUnix) {
    embed.setFooter({ text: 'Updates every 3 hours' }).setTimestamp(new Date(nextUpdateUnix * 1000));
  }
  return embed;
}
