import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createEmbed } from '../../utils/embed.js';

const TIER_LABELS = {
  normal: 'Normal',
  community_officer: 'Community Officer',
  admin_officer: 'Admin Officer',
};

const TIER_COLORS = {
  normal: 0x5865f2,
  community_officer: 0xfee75c,
  admin_officer: 0xed4245,
};

export function buildTicketInfoEmbed(userTag, userId, uuid, tier, previousCount = 0, { steamId, reason } = {}) {
  const embed = createEmbed('Ticket')
    .setTitle('Ticket')
    .setDescription(`Opened by **${userTag}** (<@${userId}>)`)
    .addFields(
      { name: 'Ticket ID', value: uuid, inline: true },
      { name: 'Tier', value: TIER_LABELS[tier] || tier, inline: true }
    )
    .setColor(TIER_COLORS[tier] || 0x5865f2);

  if (steamId) {
    embed.addFields({
      name: 'Steam ID',
      value: [
        `[${steamId}](https://steamcommunity.com/profiles/${steamId})`,
        `[steamid.io](https://steamid.io/lookup/${steamId})`,
        `[BattleMetrics](https://www.battlemetrics.com/rcon/players?filter[search]=${steamId})`,
        `[CBL](https://communitybanlist.com/search/${steamId})`,
      ].join(' | '),
    });
  }

  if (reason) {
    embed.addFields({ name: 'Reason', value: reason });
  }

  if (previousCount > 0) {
    embed.addFields({
      name: 'History',
      value: `This user has **${previousCount}** previous ticket${previousCount === 1 ? '' : 's'}. Use \`!logs\` to see them.`,
    });
  }

  return embed;
}

export function buildTicketComponents(tier) {
  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_close')
      .setLabel('Close Ticket')
      .setStyle(ButtonStyle.Secondary)
  );

  if (tier !== 'normal') {
    return [closeRow];
  }

  const escalationRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_escalate_co')
      .setLabel('Escalate to Community Officer')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('ticket_escalate_admin')
      .setLabel('Escalate to Admin Officer')
      .setStyle(ButtonStyle.Danger)
  );

  return [closeRow, escalationRow];
}
