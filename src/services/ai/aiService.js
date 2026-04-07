import Anthropic from '@anthropic-ai/sdk'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { query } from '../../database/connection.js'
import config from '../../config.js'
import logger from '../../logger.js'

const log = logger.child({ module: 'ai' })

export const ALLOWED_USER_ID = '195412349153312768'

// ── Load rules at startup ──
const __dirname = dirname(fileURLToPath(import.meta.url))
const rulesPath = join(__dirname, '../../data/rules.txt')
let serverRules
try {
  serverRules = readFileSync(rulesPath, 'utf-8')
  log.info('Server rules loaded for AI suggestions')
} catch (err) {
  log.warn({ err }, 'Could not load rules.txt - AI suggestions will work without rules context')
  serverRules = ''
}

// ── Anthropic client (lazy init) ──
let client = null

function getClient() {
  if (!config.anthropic.apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured')
  }
  if (!client) {
    client = new Anthropic({ apiKey: config.anthropic.apiKey })
    log.info('Anthropic client initialized')
  }
  return client
}

export function isAvailable() {
  return !!config.anthropic.apiKey
}

// ── DB queries ──

async function getTicketMessages(ticketId) {
  return await query(
    'SELECT author_tag, content, is_staff, created_at FROM ticket_messages WHERE ticket_id = ? ORDER BY id ASC',
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

function formatDate(d) {
  return new Date(d).toISOString().slice(0, 10)
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

function buildSystemPrompt(ticket, userHistory, similarCases) {
  return `You are an assistant for Discord server moderators at Royal Battalion, a gaming community for Squad.

You are analyzing a support ticket to help staff decide how to respond.

TICKET CONTEXT:
- Ticket ID: ${ticket.uuid}
- Tier: ${TIER_LABELS[ticket.tier] || ticket.tier}
- Reason given at creation: ${ticket.reason || 'None provided'}

USER HISTORY:
${buildHistorySection(userHistory)}

SIMILAR PAST CASES:
${buildSimilarCasesSection(similarCases)}

SERVER RULES:
${serverRules || 'No rules document loaded.'}

INSTRUCTIONS:
Analyze the conversation and provide your response in EXACTLY this format:

**Rules Applied:**
[List which specific rules are relevant to this ticket, with rule numbers if applicable. If no rules apply directly, say "No specific rules apply - general support request."]

**Suggested Action:**
[Recommend what the staff member should do - e.g., warn the user, escalate, close, request more information, etc. Be specific and actionable. Consider the user's history and similar past cases when suggesting actions. If past cases show a pattern of resolution, recommend a consistent approach.]

**Draft Reply:**
[Write a professional, friendly draft message that staff could send to the user. Write it from the perspective of server staff addressing the user directly. Keep it concise.]

Keep your analysis brief and practical. Staff are busy - give them actionable information, not essays.`
}

function buildConversationMessages(messages) {
  const recent = messages.slice(-50)
  const transcript = recent.map((m) => {
    const role = m.is_staff ? 'STAFF' : 'USER'
    const time = new Date(m.created_at).toISOString().slice(0, 16).replace('T', ' ')
    const content = m.content || '[attachment only]'
    return `[${time}] ${role} (${m.author_tag}): ${content}`
  }).join('\n')

  return [
    {
      role: 'user',
      content: `Here is the ticket conversation transcript:\n\n${transcript}\n\nPlease analyze this ticket and provide your suggestion.`,
    },
  ]
}

// ── Response parser ──

function parseAIResponse(text) {
  const rulesMatch = text.match(/\*\*Rules Applied:\*\*\s*([\s\S]*?)(?=\*\*Suggested Action:\*\*)/i)
  const actionMatch = text.match(/\*\*Suggested Action:\*\*\s*([\s\S]*?)(?=\*\*Draft Reply:\*\*)/i)
  const replyMatch = text.match(/\*\*Draft Reply:\*\*\s*([\s\S]*?)$/i)

  return {
    rulesApplied: rulesMatch?.[1]?.trim() || 'Could not parse rules section.',
    suggestedAction: actionMatch?.[1]?.trim() || 'Could not parse action section.',
    draftReply: replyMatch?.[1]?.trim() || 'Could not parse reply section.',
  }
}

// ── Main function ──

export async function generateTicketSuggestion(ticket) {
  const anthropic = getClient()
  const [messages, userHistory, similarCases] = await Promise.all([
    getTicketMessages(ticket.id),
    getUserTicketHistory(ticket.user_id),
    findSimilarTickets(ticket.reason, ticket.id, ticket.user_id),
  ])

  if (messages.length === 0) {
    return { error: 'No messages found in this ticket.' }
  }

  const systemPrompt = buildSystemPrompt(ticket, userHistory, similarCases)
  const conversationMessages = buildConversationMessages(messages)

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: conversationMessages,
    })

    const text = response.content[0]?.text
    if (!text) {
      return { error: 'AI returned an empty response.' }
    }

    log.info({ ticketId: ticket.id, inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens }, 'AI suggestion generated')
    return parseAIResponse(text)
  } catch (err) {
    log.error({ err, ticketId: ticket.id }, 'AI suggestion request failed')
    if (err.status === 429) {
      return { error: 'AI rate limit reached. Please try again in a moment.' }
    }
    return { error: 'Failed to generate AI suggestion. Check logs for details.' }
  }
}
