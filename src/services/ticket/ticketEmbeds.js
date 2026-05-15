import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createEmbed } from '../../utils/embed.js';

export const TIER_LABELS = {
  normal: 'Normal',
  community_officer: 'Community Officer',
  admin_officer: 'Admin Officer',
  comp_team: 'Comp Team',
  whitelist: 'Whitelist',
};

export const TIER_COLORS = {
  normal: 0x5865f2,
  community_officer: 0xaaa600,
  admin_officer: 0x4bffc0,
  comp_team: 0x57f287,
  whitelist: 0x6bb8f0,
};

export const TIER_CHANNEL_PREFIX = {
  normal: '',
  community_officer: 'CO-',
  admin_officer: 'AO-',
  comp_team: 'Comp-',
  whitelist: 'WH-',
};

export function buildTicketInfoEmbed(userTag, userId, uuid, tier, previousCount = 0, { steamId, reason, bmPlayerId } = {}) {
  const tierLabel = TIER_LABELS[tier] || tier;
  const title = tier === 'normal' ? 'Ticket' : `${tierLabel} Ticket`;
  const embed = createEmbed('Ticket')
    .setTitle(title)
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
        `[steamid.com](https://www.steamid.com/profiles/${steamId})`,
        `[BattleMetrics](${bmPlayerId ? `https://www.battlemetrics.com/rcon/players/${bmPlayerId}` : `https://www.battlemetrics.com/rcon/players?filter[search]=${steamId}`})`,
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

const TRANSFER_BUTTONS = [
  { tier: 'normal', customId: 'ticket_escalate_normal', label: 'Normal', emoji: '\u{1F4E5}', style: ButtonStyle.Secondary },
  { tier: 'admin_officer', customId: 'ticket_escalate_admin', label: 'AO', emoji: '\u{1F6E1}\u{FE0F}', style: ButtonStyle.Primary },
  { tier: 'community_officer', customId: 'ticket_escalate_co', label: 'CO', emoji: '\u{1F91D}', style: ButtonStyle.Primary },
  { tier: 'whitelist', customId: 'ticket_escalate_wl', label: 'WL', emoji: '\u{1F4CB}', style: ButtonStyle.Primary },
  { tier: 'comp_team', customId: 'ticket_escalate_comp', label: 'Comp', emoji: '\u{2694}\u{FE0F}', style: ButtonStyle.Success },
];

export const DONATE_PAYPAL_URL = 'https://www.paypal.com/paypalme/royalbattalionclan';

export function buildDonationEmbed() {
  return createEmbed('Donation')
    .setTitle('Support Royal Battalion')
    .setDescription(`Get **30 days of whitelist for £5** by donating via PayPal:\n[paypal.me/royalbattalionclan](${DONATE_PAYPAL_URL})`)
    .addFields({
      name: 'After donating, reply here with:',
      value: [
        '- Donation amount',
        '- PayPal transaction ID',
        '- Your SteamID64',
      ].join('\n'),
    })
    .setColor(TIER_COLORS.whitelist);
}

export function buildTicketComponents(tier, anonymousMode = false) {
  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_close')
      .setLabel('Close')
      .setEmoji('\u{1F512}')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('ticket_timeout')
      .setLabel('Timeout')
      .setEmoji('\u{23F0}')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('ticket_anonymous')
      .setLabel(anonymousMode ? 'Anonymous: ON' : 'Anonymous')
      .setStyle(anonymousMode ? ButtonStyle.Success : ButtonStyle.Secondary)
  );

  if (tier === 'whitelist') {
    closeRow.addComponents(
      new ButtonBuilder()
        .setCustomId('ticket_donate')
        .setLabel('Donate')
        .setEmoji('\u{1F4B7}')
        .setStyle(ButtonStyle.Success)
    );
  }

  const transferButtons = TRANSFER_BUTTONS
    .filter((b) => b.tier !== tier)
    .map((b) =>
      new ButtonBuilder()
        .setCustomId(b.customId)
        .setLabel(b.label)
        .setEmoji(b.emoji)
        .setStyle(b.style)
    );

  const transferRow = new ActionRowBuilder().addComponents(...transferButtons);

  return [closeRow, transferRow];
}
