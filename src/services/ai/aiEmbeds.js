import { createEmbed } from '../../utils/embed.js'

function truncate(text, max) {
  if (text.length <= max) return text
  return text.slice(0, max - 3) + '...'
}

export function buildSuggestionEmbed(suggestion) {
  return createEmbed('AI Suggestion')
    .setTitle('AI Ticket Suggestion')
    .setDescription('Analysis based on server rules and conversation context.')
    .addFields(
      { name: 'Rules Applied', value: truncate(suggestion.rulesApplied, 1024) },
      { name: 'Suggested Action', value: truncate(suggestion.suggestedAction, 1024) },
      { name: 'Draft Reply', value: truncate(`\`\`\`\n${suggestion.draftReply}\n\`\`\``, 1024) },
    )
    .setColor(0xe6a817)
}
