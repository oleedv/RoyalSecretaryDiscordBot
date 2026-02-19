import { SlashCommandBuilder } from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check bot latency'),

  async execute(interaction) {
    const response = await interaction.reply({ content: 'Pinging...', withResponse: true });
    const roundtrip = response.resource.message.createdTimestamp - interaction.createdTimestamp;
    const wsHeartbeat = interaction.client.ws.ping;

    await interaction.editReply(
      `Pong! Roundtrip: **${roundtrip}ms** | WebSocket: **${wsHeartbeat}ms**`
    );
  },
};
