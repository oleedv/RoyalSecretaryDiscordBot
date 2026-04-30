import { SlashCommandBuilder } from 'discord.js';
import { errorEmbed } from '../utils/embed.js';
import { isAvailable, generateTicketSuggestion, ALLOWED_USER_ID } from '../services/ai/aiService.js';
import { buildSuggestionEmbed, buildSuggestionComponents, totalPagesOf } from '../services/ai/aiEmbeds.js';
import { saveSuggestion } from '../services/ai/suggestionRepo.js';
import { getTicketByChannel } from '../services/ticket/ticketService.js';
import logger from '../logger.js';

const log = logger.child({ module: 'suggestCommand' });

export default {
  data: new SlashCommandBuilder()
    .setName('suggest')
    .setDescription('Generate an AI suggestion for the current ticket'),

  async execute(interaction) {
    if (interaction.user.id !== ALLOWED_USER_ID) {
      return interaction.reply({ embeds: [errorEmbed('You are not authorized to use AI suggestions.')], flags: ['Ephemeral'] });
    }

    if (!isAvailable()) {
      return interaction.reply({ embeds: [errorEmbed('AI suggestions are not configured.')], flags: ['Ephemeral'] });
    }

    await interaction.deferReply({ flags: ['Ephemeral'] });

    const ticket = await getTicketByChannel(interaction.channel.id);
    if (!ticket) {
      return interaction.editReply({ embeds: [errorEmbed('No open ticket found for this channel.')] });
    }

    const result = await generateTicketSuggestion(ticket);
    if (result.error) {
      return interaction.editReply({ embeds: [errorEmbed(result.error)] });
    }

    const totalPages = totalPagesOf(result);
    const sent = await interaction.editReply({ embeds: [buildSuggestionEmbed(result, 1)] });
    try {
      await saveSuggestion({
        messageId: sent.id,
        channelId: interaction.channel.id,
        ticketId: ticket.id,
        suggestion: result,
      });
    } catch (err) {
      log.error({ err, ticketId: ticket.id }, 'Failed to persist AI suggestion');
    }
    if (totalPages > 1) {
      await interaction.editReply({ components: buildSuggestionComponents(sent.id, 1, totalPages) });
    }
    log.info({ ticketId: ticket.id, staffId: interaction.user.id, totalPages }, 'AI suggestion generated via /suggest');
  },
};
