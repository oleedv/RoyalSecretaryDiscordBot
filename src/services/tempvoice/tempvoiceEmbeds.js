import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';

export function buildControlPanelEmbed() {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Channel Controls')
    .setDescription(
      'Manage your temporary voice channel using the buttons below.\n\n' +
      '**Channel Settings**\n' +
      '\u270F\uFE0F **Name** -- Rename your channel\n' +
      '\u{1F465} **Limit** -- Set user limit (0-99)\n' +
      '\u{1F512} **Privacy** -- Lock, unlock, hide, or control chat\n' +
      '\u{1F6D1} **DND** -- Disable all voice activity\n' +
      '\u{1F30D} **Region** -- Change voice region\n\n' +
      '**Member Management**\n' +
      '\u2705 **Trust** -- Grant a user access\n' +
      '\u274C **Untrust** -- Revoke a user\'s access\n' +
      '\u{1F6AB} **Block** -- Block a user from your channel\n' +
      '\u{1F513} **Unblock** -- Remove a block\n' +
      '\u{1F3B5} **Bitrate** -- Change audio quality\n\n' +
      '**Actions**\n' +
      '\u{1F4E8} **Invite** -- Send a channel invite via DM\n' +
      '\u{1F45F} **Kick** -- Remove a user from the channel\n' +
      '\u{1F451} **Claim** -- Take ownership of an abandoned channel\n' +
      '\u{1F501} **Transfer** -- Give ownership to another user\n' +
      '\u{1F5D1}\uFE0F **Delete** -- Delete this channel',
    )
    .setFooter({ text: 'Royal Battalion -- RoyalVoice' })
    .setTimestamp();
}

export function buildControlPanelComponents() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tv_name').setEmoji('\u270F\uFE0F').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('tv_limit').setEmoji('\u{1F465}').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('tv_privacy').setEmoji('\u{1F512}').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('tv_dnd').setEmoji('\u{1F6D1}').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('tv_region').setEmoji('\u{1F30D}').setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tv_trust').setEmoji('\u2705').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('tv_untrust').setEmoji('\u274C').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('tv_block').setEmoji('\u{1F6AB}').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('tv_unblock').setEmoji('\u{1F513}').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('tv_bitrate').setEmoji('\u{1F3B5}').setStyle(ButtonStyle.Secondary),
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tv_invite').setEmoji('\u{1F4E8}').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('tv_kick').setEmoji('\u{1F45F}').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('tv_claim').setEmoji('\u{1F451}').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('tv_transfer').setEmoji('\u{1F501}').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('tv_delete').setEmoji('\u{1F5D1}\uFE0F').setStyle(ButtonStyle.Danger),
  );

  return [row1, row2, row3];
}

export function buildControlPanelMessage() {
  return {
    embeds: [buildControlPanelEmbed()],
    components: buildControlPanelComponents(),
  };
}
