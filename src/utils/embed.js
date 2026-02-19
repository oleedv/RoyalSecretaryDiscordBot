import { EmbedBuilder } from 'discord.js';

export function createEmbed(type) {
  return new EmbedBuilder()
    .setFooter({ text: `Royal Battalion ● ${type}` })
    .setTimestamp();
}
