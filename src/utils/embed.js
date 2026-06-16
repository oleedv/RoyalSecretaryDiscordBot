import { EmbedBuilder } from 'discord.js';

export function createEmbed(type) {
  return new EmbedBuilder()
    .setFooter({ text: type ? `Royal Battalion ● ${type}` : 'Royal Battalion' })
    .setTimestamp();
}

export function successEmbed(description) {
  return createEmbed('Response').setColor(0x57f287).setDescription(description);
}

export function errorEmbed(description) {
  return createEmbed('Response').setColor(0xed4245).setDescription(description);
}

export function infoEmbed(description) {
  return createEmbed('Response').setColor(0x5865f2).setDescription(description);
}

/**
 * Build the embed a user sees when a staff reply is relayed into their DM.
 * Mirrors the staff-channel log embed. When anonymous, the staff identity is
 * hidden: name is whatever the caller passes (e.g. "Staff"), no avatar, grey.
 */
export function buildRelayEmbed({ type, senderName, avatarUrl, content, anonymous = false }) {
  const author = { name: senderName };
  if (!anonymous && avatarUrl) author.iconURL = avatarUrl;

  return createEmbed(type)
    .setAuthor(author)
    .setDescription(content || '*Attachment only*')
    .setColor(anonymous ? 0x99aab5 : 0x5865f2);
}
