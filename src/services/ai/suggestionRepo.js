import { query } from '../../database/connection.js'

const RETENTION_DAYS = 30

function parseSuggestionField(raw) {
  if (raw == null) return null
  if (typeof raw === 'string') return JSON.parse(raw)
  return raw
}

export async function saveSuggestion({ messageId, channelId, ticketId, suggestion }) {
  const json = JSON.stringify(suggestion)
  await query(
    `INSERT INTO ai_suggestions (message_id, channel_id, ticket_id, suggestion)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       suggestion = VALUES(suggestion),
       channel_id = VALUES(channel_id),
       ticket_id = VALUES(ticket_id),
       created_at = CURRENT_TIMESTAMP`,
    [messageId, channelId, ticketId ?? null, json],
  )
}

export async function getSuggestion(messageId) {
  const rows = await query(
    `SELECT suggestion FROM ai_suggestions
     WHERE message_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL ? DAY)
     LIMIT 1`,
    [messageId, RETENTION_DAYS],
  )
  if (!rows || rows.length === 0) return null
  return parseSuggestionField(rows[0].suggestion)
}

export async function deleteExpiredSuggestions() {
  return query(
    `DELETE FROM ai_suggestions WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [RETENTION_DAYS],
  )
}
