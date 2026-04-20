import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js'
import { createEmbed } from '../../utils/embed.js'

const SECTION_MAX = 1000
const REPLY_MAX = 1000
const PLACEHOLDER = '*(no more content)*'

function packByDelimiter(pieces, delimiter, maxLen) {
  const out = []
  let current = ''
  for (const piece of pieces) {
    if (piece.length > maxLen) {
      if (current.length > 0) { out.push(current); current = '' }
      out.push(...splitOversized(piece, maxLen))
      continue
    }
    if (current.length === 0) {
      current = piece
    } else if (current.length + delimiter.length + piece.length <= maxLen) {
      current += delimiter + piece
    } else {
      out.push(current)
      current = piece
    }
  }
  if (current.length > 0) out.push(current)
  return out
}

function splitOversized(text, maxLen) {
  const lines = text.split('\n')
  if (lines.length > 1) return packByDelimiter(lines, '\n', maxLen)
  const words = text.split(/\s+/).filter((w) => w.length > 0)
  if (words.length > 1) return packByDelimiter(words, ' ', maxLen)
  const out = []
  for (let i = 0; i < text.length; i += maxLen) out.push(text.slice(i, i + maxLen))
  return out
}

export function chunkSection(text, maxLen = SECTION_MAX) {
  const trimmed = (text ?? '').trim()
  if (trimmed.length === 0) return ['(none)']
  if (trimmed.length <= maxLen) return [trimmed]
  const paragraphs = trimmed.split(/\n{2,}/)
  return packByDelimiter(paragraphs, '\n\n', maxLen)
}

export function chunkDraftReply(text, maxLen = REPLY_MAX) {
  const chunks = chunkSection(text, maxLen)
  return chunks.map((c) => '```\n' + c + '\n```')
}

function buildPageSections(suggestion) {
  return {
    rulesChunks: chunkSection(suggestion.rulesApplied),
    flagsChunks: chunkSection(suggestion.externalDataFlags),
    actionChunks: chunkSection(suggestion.suggestedAction),
    replyChunks: chunkDraftReply(suggestion.draftReply),
  }
}

export function totalPagesOf(suggestion) {
  const { rulesChunks, flagsChunks, actionChunks, replyChunks } = buildPageSections(suggestion)
  return Math.max(rulesChunks.length, flagsChunks.length, actionChunks.length, replyChunks.length)
}

function labelFor(name, chunks, pageIndex) {
  if (chunks.length <= 1) return name
  if (pageIndex >= chunks.length) return name
  return `${name} (${pageIndex + 1}/${chunks.length})`
}

function valueFor(chunks, pageIndex) {
  if (pageIndex >= chunks.length) return PLACEHOLDER
  return chunks[pageIndex]
}

export function buildSuggestionEmbed(suggestion, page = 1) {
  const sections = buildPageSections(suggestion)
  const { rulesChunks, flagsChunks, actionChunks, replyChunks } = sections
  const totalPages = Math.max(rulesChunks.length, flagsChunks.length, actionChunks.length, replyChunks.length)
  const safePage = Math.min(Math.max(1, page), totalPages)
  const i = safePage - 1

  const title = totalPages > 1
    ? `AI Ticket Suggestion — Page ${safePage}/${totalPages}`
    : 'AI Ticket Suggestion'

  return createEmbed('AI Suggestion')
    .setTitle(title)
    .setDescription('Analysis based on server rules and conversation context.')
    .addFields(
      { name: labelFor('Rules Applied', rulesChunks, i), value: valueFor(rulesChunks, i) },
      { name: labelFor('External Data Flags', flagsChunks, i), value: valueFor(flagsChunks, i) },
      { name: labelFor('Suggested Action', actionChunks, i), value: valueFor(actionChunks, i) },
      { name: labelFor('Draft Reply', replyChunks, i), value: valueFor(replyChunks, i) },
    )
    .setColor(0xe6a817)
}

export function buildSuggestionComponents(messageId, page, totalPages) {
  if (totalPages <= 1) return []
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`sugg_prev:${page - 1}:${messageId}`)
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId('sugg_indicator')
      .setLabel(`${page} / ${totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`sugg_next:${page + 1}:${messageId}`)
      .setLabel('Next')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page >= totalPages),
  )
  return [row]
}

export function parseSuggestionCustomId(customId) {
  if (!customId) return null
  const parts = customId.split(':')
  if (parts.length !== 3) return null
  const [prefix, targetPageRaw, messageId] = parts
  if (prefix !== 'sugg_prev' && prefix !== 'sugg_next') return null
  const targetPage = parseInt(targetPageRaw, 10)
  if (!Number.isFinite(targetPage) || targetPage < 1) return null
  if (!messageId) return null
  return { action: prefix === 'sugg_prev' ? 'prev' : 'next', targetPage, messageId }
}
