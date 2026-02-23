import { EmbedBuilder } from 'discord.js';

export function createEmbed(type) {
  return new EmbedBuilder()
    .setFooter({ text: `Royal Battalion ● ${type}` })
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
