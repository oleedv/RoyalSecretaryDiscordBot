import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { query } from '../../database/connection.js'
import config from '../../config.js'
import logger from '../../logger.js'
import { getStoredSteamId } from '../userService.js'
import { fetchCblData } from '../cblService.js'
import { getSteamProfile, getSteamBans } from '../steamService.js'
import { getPlayerProfile } from '../battlemetricsService.js'
import { formatBMNotes, formatBMFlags } from './bmFormat.js'
import { fetchImagesAsBase64 } from '../../utils/attachments.js'
import { getAnthropicClient, isAnthropicAvailable } from './anthropicClient.js'
import { formatDate } from '../../utils/formatters.js'

const log = logger.child({ module: 'ai' })

export const ALLOWED_USER_ID = '195412349153312768'

// ── Load reference documents at startup ──
const __dirname = dirname(fileURLToPath(import.meta.url))

function loadDataFile(filename) {
  try {
    const content = readFileSync(join(__dirname, '../../data', filename), 'utf-8')
    log.info(`Loaded ${filename} for AI suggestions`)
    return content
  } catch (err) {
    log.warn({ err }, `Could not load ${filename} - AI suggestions will work without it`)
    return ''
  }
}

const serverRules = loadDataFile('rules.txt')
const owiCodeOfConduct = loadDataFile('owi-code-of-conduct.txt')
const owiServerLicensing = loadDataFile('owi-server-licensing.txt')

export function isAvailable() {
  return isAnthropicAvailable()
}

// ── DB queries ──

async function getTicketMessages(ticketId) {
  return await query(
    'SELECT author_tag, content, is_staff, created_at, attachments FROM ticket_messages WHERE ticket_id = ? ORDER BY id ASC',
    [ticketId]
  )
}

async function getUserTicketHistory(userId) {
  return await query(
    `SELECT t.uuid, t.tier, t.reason, t.created_at,
      (SELECT tm.content FROM ticket_messages tm WHERE tm.ticket_id = t.id AND tm.is_staff = 0 ORDER BY tm.id ASC LIMIT 1) AS first_message,
      (SELECT GROUP_CONCAT(te.event_type ORDER BY te.id SEPARATOR ', ') FROM ticket_events te WHERE te.ticket_id = t.id) AS events
    FROM tickets t
    WHERE t.user_id = ? AND t.status = 'closed'
    ORDER BY t.created_at DESC
    LIMIT 10`,
    [userId]
  )
}

const STOP_WORDS = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one', 'our', 'out', 'has', 'have', 'been', 'this', 'that', 'with', 'from', 'they', 'will', 'would', 'there', 'their', 'what', 'about', 'which', 'when', 'make', 'like', 'just', 'over', 'such', 'take', 'than', 'them', 'very', 'some', 'could', 'into', 'other', 'then', 'because', 'these', 'also', 'after', 'know', 'being', 'want', 'need', 'please', 'help', 'ticket'])

function extractKeywords(text) {
  if (!text) return []
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
    .slice(0, 5)
}

async function findSimilarTickets(reason, ticketId, userId) {
  const keywords = extractKeywords(reason)
  if (keywords.length === 0) return []

  const likeClauses = keywords.map(() => 't.reason LIKE ?').join(' OR ')
  const likeParams = keywords.map((w) => `%${w}%`)

  return await query(
    `SELECT t.uuid, t.tier, t.reason, t.created_at,
      (SELECT tm.content FROM ticket_messages tm WHERE tm.ticket_id = t.id AND tm.is_staff = 0 ORDER BY tm.id ASC LIMIT 1) AS first_user_message,
      (SELECT tm.content FROM ticket_messages tm WHERE tm.ticket_id = t.id AND tm.is_staff = 1 ORDER BY tm.id ASC LIMIT 1) AS first_staff_reply,
      (SELECT GROUP_CONCAT(te.event_type ORDER BY te.id SEPARATOR ', ') FROM ticket_events te WHERE te.ticket_id = t.id) AS events
    FROM tickets t
    WHERE t.status = 'closed'
      AND t.id != ?
      AND t.user_id != ?
      AND (${likeClauses})
    ORDER BY t.created_at DESC
    LIMIT 5`,
    [ticketId, userId, ...likeParams]
  )
}

// ── Prompt builders ──

const TIER_LABELS = {
  normal: 'Normal',
  community_officer: 'Community Officer',
  admin_officer: 'Admin Officer',
  comp_team: 'Comp Team',
  whitelist: 'Whitelist',
}

function buildHistorySection(history) {
  if (!history || history.length === 0) return 'This user has no previous tickets.'
  const lines = history.map((t, i) => {
    const reason = t.reason ? t.reason.slice(0, 80) : 'No reason'
    return `${i + 1}. [${formatDate(t.created_at)}] Tier: ${TIER_LABELS[t.tier] || t.tier} | Reason: ${reason} | Outcome: ${t.events || 'unknown'}`
  })
  return `This user has ${history.length} previous ticket${history.length === 1 ? '' : 's'}:\n${lines.join('\n')}`
}

function buildSimilarCasesSection(cases) {
  if (!cases || cases.length === 0) return 'No similar past cases found.'
  const lines = cases.map((t, i) => {
    const reason = t.reason ? t.reason.slice(0, 80) : 'No reason'
    const userMsg = t.first_user_message ? t.first_user_message.slice(0, 120) : 'N/A'
    const staffMsg = t.first_staff_reply ? t.first_staff_reply.slice(0, 120) : 'N/A'
    return `${i + 1}. [${formatDate(t.created_at)}] Tier: ${TIER_LABELS[t.tier] || t.tier} | Reason: ${reason}\n   User said: ${userMsg}\n   Staff replied: ${staffMsg}\n   Outcome: ${t.events || 'unknown'}`
  })
  return lines.join('\n')
}

function buildExternalDataSection({ steamId, cblData, steamProfile, steamBans, bmBans, bmNotes, bmFlags }) {
  if (!steamId) return 'No Steam ID linked to this user - external data unavailable.'

  const sections = []
  sections.push(`Steam ID: ${steamId}`)

  if (steamProfile) {
    const lines = [`Profile Visibility: ${steamProfile.visibility}`]
    if (steamProfile.personaName) lines.push(`Display Name: ${steamProfile.personaName}`)
    if (steamProfile.accountCreated) lines.push(`Account Created: ${steamProfile.accountCreated}`)
    sections.push('STEAM PROFILE:\n' + lines.map((l) => `  ${l}`).join('\n'))
  }

  if (steamBans) {
    const lines = []
    lines.push(`VAC Banned: ${steamBans.vacBanned ? 'YES' : 'No'} (${steamBans.numberOfVacBans} ban${steamBans.numberOfVacBans !== 1 ? 's' : ''})`)
    if (steamBans.vacBanned && steamBans.daysSinceLastBan > 0) lines.push(`Days Since Last Ban: ${steamBans.daysSinceLastBan}`)
    lines.push(`Game Bans: ${steamBans.numberOfGameBans}`)
    lines.push(`Community Banned: ${steamBans.communityBanned ? 'YES' : 'No'}`)
    if (steamBans.economyBan !== 'none') lines.push(`Economy Ban: ${steamBans.economyBan}`)
    sections.push('STEAM BANS:\n' + lines.map((l) => `  ${l}`).join('\n'))
  }

  if (cblData) {
    const lines = []
    lines.push(`Risk Rating: ${cblData.riskRating ?? 0}/10`)
    lines.push(`Reputation Points: ${cblData.reputationPoints ?? 0}`)
    const activeBans = cblData.bans?.edges?.map((e) => e.node) ?? []
    const expiredCount = cblData.expiredBans?.edges?.length ?? 0
    lines.push(`Active Bans: ${activeBans.length}`)
    lines.push(`Expired Bans: ${expiredCount}`)
    for (const ban of activeBans) {
      const org = ban.banList?.organisation?.name || 'Unknown'
      const reason = ban.reason || 'No reason'
      const created = ban.created ? new Date(ban.created).toISOString().slice(0, 10) : '?'
      lines.push(`- ${org}: ${reason} (${created})`)
    }
    sections.push('COMMUNITY BAN LIST (CBL):\n' + lines.map((l) => `  ${l}`).join('\n'))
  }

  if (bmBans) {
    const lines = []
    lines.push(`Active Bans: ${bmBans.activeBans.length}`)
    lines.push(`Expired Bans: ${bmBans.expiredBanCount}`)
    for (const ban of bmBans.activeBans.slice(0, 10)) {
      const expiry = ban.permanent ? 'permanent' : `expires ${ban.expires ? new Date(ban.expires).toISOString().slice(0, 10) : '?'}`
      const created = ban.created ? new Date(ban.created).toISOString().slice(0, 10) : '?'
      lines.push(`- ${ban.serverName}: ${ban.reason} (${created}, ${expiry})`)
    }
    sections.push('BATTLEMETRICS BANS:\n' + lines.map((l) => `  ${l}`).join('\n'))
  }

  if (bmNotes && bmNotes.length > 0) {
    const rendered = formatBMNotes(bmNotes.slice(0, 10))
    sections.push('BATTLEMETRICS STAFF NOTES:\n' + rendered.split('\n').map((l) => `  ${l}`).join('\n'))
  }

  if (bmFlags && bmFlags.length > 0) {
    const rendered = formatBMFlags(bmFlags)
    sections.push('BATTLEMETRICS FLAGS:\n' + rendered.split('\n').map((l) => `  ${l}`).join('\n'))
  }

  return sections.join('\n\n')
}

function buildSystemPrompt() {
  return `You are an assistant for Discord server moderators at Royal Battalion, a gaming community for Squad.

You are analyzing a support ticket to help staff decide how to respond.

SERVER RULES:
${serverRules || 'No rules document loaded.'}

OWI CODE OF CONDUCT:
${owiCodeOfConduct || 'Not loaded.'}

OWI SERVER LICENSING & ADMINISTRATION POLICIES:
${owiServerLicensing || 'Not loaded.'}

INSTRUCTIONS:
The user turn will begin with a TICKET CONTEXT block (ticket metadata, this user's prior ticket history, similar past cases, and external player data) followed by the ticket conversation transcript. Use the TICKET CONTEXT block to inform your analysis — the conversation transcript is the primary evidence.

If the conversation includes attached images, examine them carefully. Users often share screenshots of in-game events, ban messages, error screens, or chat logs as evidence. Consider any text or visual information in the images when forming your analysis.

Analyze the conversation and provide your response in EXACTLY this format:

**Rules Applied:**
[List which specific server rules AND/OR OWI policies are relevant to this ticket. Cite rule numbers or OWI policy codes (e.g. A1.9, L1.12) when applicable. If the ticket involves OWI-level concerns (e.g. player threatening to report to OWI, ban appeal rights, admin conduct standards), reference the relevant OWI policy. If no rules apply directly, say "No specific rules apply - general support request."]

**External Data Flags:**
[Flag any concerning findings from the external player data: VAC/game bans, CBL active bans or high risk rating, BattleMetrics bans, concerning staff notes, concerning BattleMetrics flags (e.g. "Recruit-watch", "Cheater-adjacent"), private Steam profile, very new account. Positive flags (e.g. "Whitelisted", "Trusted") should reduce concern. If nothing concerning is found, say "No flags from external data." Be specific about what you found and cite the data.]

**Suggested Action:**
[Recommend what the staff member should do - e.g., warn the user, escalate, close, request more information, etc. Be specific and actionable. Consider the user's history and similar past cases when suggesting actions. If past cases show a pattern of resolution, recommend a consistent approach.]

**Draft Reply:**
[Write a professional, friendly draft message that staff could send to the user. Write it from the perspective of server staff addressing the user directly. Keep it concise.]

Consider external player data (bans, risk ratings, staff notes, BattleMetrics flags) when assessing the situation and suggesting actions. Staff notes and flags are admin-authored and outrank self-reported user content.
Keep your analysis brief and practical. Staff are busy - give them actionable information, not essays.`
}

function buildTicketContextBlock(ticket, userHistory, similarCases, externalDataSection) {
  return `TICKET CONTEXT:
- Ticket ID: ${ticket.uuid}
- Tier: ${TIER_LABELS[ticket.tier] || ticket.tier}
- Reason given at creation: ${ticket.reason || 'None provided'}

USER HISTORY:
${buildHistorySection(userHistory)}

SIMILAR PAST CASES:
${buildSimilarCasesSection(similarCases)}

EXTERNAL PLAYER DATA:
${externalDataSection || 'No external data available.'}`
}

async function buildConversationMessages(messages, ticketContextText) {
  const recent = messages.slice(-50)
  const MAX_IMAGES = 10

  // Collect image attachments per message, respecting the global budget
  let imagesBudget = MAX_IMAGES
  const perMessageAttachments = recent.map((m) => {
    if (imagesBudget <= 0) return []
    const images = (m.attachments || []).filter((a) => a.contentType?.startsWith('image/'))
    const batch = images.slice(0, imagesBudget)
    imagesBudget -= batch.length
    return batch
  })

  // Fetch all images in one parallel batch
  const allImages = perMessageAttachments.flat()
  const fetched = allImages.length > 0 ? await fetchImagesAsBase64(allImages, allImages.length) : []

  // Map fetched results back to per-message buckets
  let fetchIdx = 0
  const fetchedPerMessage = perMessageAttachments.map((imgs) => {
    const slice = fetched.slice(fetchIdx, fetchIdx + imgs.length)
    fetchIdx += imgs.length
    return slice
  })

  // Build interleaved text + image content blocks. Ticket context first, then
  // the conversation transcript — keeps the system prompt purely static so it
  // can be cached across requests.
  const contentBlocks = [
    { type: 'text', text: ticketContextText },
    { type: 'text', text: '\nHere is the ticket conversation transcript:\n' },
  ]

  for (let i = 0; i < recent.length; i++) {
    const m = recent[i]
    const role = m.is_staff ? 'STAFF' : 'USER'
    const time = new Date(m.created_at).toISOString().slice(0, 16).replace('T', ' ')
    const content = m.content || '[attachment only]'
    const imgs = fetchedPerMessage[i]

    let line = `[${time}] ${role} (${m.author_tag}): ${content}`
    if (imgs.length > 0) line += ` [${imgs.length} image(s) attached below]`

    contentBlocks.push({ type: 'text', text: line })

    for (const img of imgs) {
      contentBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: img.media_type, data: img.data },
      })
    }
  }

  contentBlocks.push({
    type: 'text',
    text: '\nPlease analyze this ticket and provide your suggestion. If images were included, consider any text, screenshots, or evidence visible in them.',
  })

  return [{ role: 'user', content: contentBlocks }]
}

// ── Response parser ──

function parseAIResponse(text) {
  const rulesMatch = text.match(/\*\*Rules Applied:\*\*\s*([\s\S]*?)(?=\*\*External Data Flags:\*\*)/i)
  const flagsMatch = text.match(/\*\*External Data Flags:\*\*\s*([\s\S]*?)(?=\*\*Suggested Action:\*\*)/i)
  const actionMatch = text.match(/\*\*Suggested Action:\*\*\s*([\s\S]*?)(?=\*\*Draft Reply:\*\*)/i)
  const replyMatch = text.match(/\*\*Draft Reply:\*\*\s*([\s\S]*?)$/i)

  return {
    rulesApplied: rulesMatch?.[1]?.trim() || 'Could not parse rules section.',
    externalDataFlags: flagsMatch?.[1]?.trim() || 'No external data flags.',
    suggestedAction: actionMatch?.[1]?.trim() || 'Could not parse action section.',
    draftReply: replyMatch?.[1]?.trim() || 'Could not parse reply section.',
  }
}

// ── Main function ──

export async function generateTicketSuggestion(ticket) {
  const anthropic = getAnthropicClient()
  const steamId = await getStoredSteamId(ticket.user_id)

  const [messages, userHistory, similarCases, cblData, steamProfile, steamBans, bmProfile] = await Promise.all([
    getTicketMessages(ticket.id),
    getUserTicketHistory(ticket.user_id),
    findSimilarTickets(ticket.reason, ticket.id, ticket.user_id),
    steamId ? fetchCblData(steamId).catch(() => null) : null,
    steamId ? getSteamProfile(steamId).catch(() => null) : null,
    steamId ? getSteamBans(steamId).catch(() => null) : null,
    steamId ? getPlayerProfile(steamId).catch(() => null) : null,
  ])

  const bmBans = bmProfile?.bans || null
  const bmNotes = bmProfile?.notes || []
  const bmFlags = bmProfile?.flags || []

  if (messages.length === 0) {
    return { error: 'No messages found in this ticket.' }
  }

  const externalDataSection = buildExternalDataSection({ steamId, cblData, steamProfile, steamBans, bmBans, bmNotes, bmFlags })
  const systemPrompt = buildSystemPrompt()
  const ticketContextText = buildTicketContextBlock(ticket, userHistory, similarCases, externalDataSection)
  const conversationMessages = await buildConversationMessages(messages, ticketContextText)

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: conversationMessages,
    })

    const text = response.content[0]?.text
    if (!text) {
      return { error: 'AI returned an empty response.' }
    }

    log.info({
      ticketId: ticket.id,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
      cacheCreationInputTokens: response.usage?.cache_creation_input_tokens,
      cacheReadInputTokens: response.usage?.cache_read_input_tokens,
    }, 'AI suggestion generated')
    return parseAIResponse(text)
  } catch (err) {
    log.error({ err, ticketId: ticket.id }, 'AI suggestion request failed')
    if (err.status === 429) {
      return { error: 'AI rate limit reached. Please try again in a moment.' }
    }
    return { error: 'Failed to generate AI suggestion. Check logs for details.' }
  }
}
