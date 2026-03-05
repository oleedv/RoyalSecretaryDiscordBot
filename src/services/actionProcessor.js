import { query } from '../database/connection.js'
import { getProspectByChannel } from './prospect/prospectService.js'
import { getTicketByChannel, getTicketByChannelStatus, beginCloseGracePeriod, escalateTicket, reopenTicket, forceCloseTicket } from './ticket/ticketService.js'
import { reassignMentor } from './prospect/teamRoleService.js'
import config from '../config.js'
import logger from '../logger.js'

const log = logger.child({ module: 'actionProcessor' })

const POLL_INTERVAL_MS = 10_000

let intervalRef = null

export function startActionProcessor(client) {
  if (intervalRef) return
  log.info('Action processor started')
  intervalRef = setInterval(() => processPending(client), POLL_INTERVAL_MS)
  // Run once immediately on startup to handle actions queued while bot was down
  processPending(client)
}

export function stopActionProcessor() {
  if (intervalRef) {
    clearInterval(intervalRef)
    intervalRef = null
  }
}

async function processPending(client) {
  let rows
  try {
    rows = await query(
      'SELECT * FROM pending_actions WHERE status = ? ORDER BY created_at ASC LIMIT 10',
      ['pending']
    )
  } catch (err) {
    log.error({ err }, 'Failed to poll pending_actions')
    return
  }

  if (rows.length === 0) return

  const guild = await client.guilds.fetch(config.guild.id).catch(() => null)
  if (!guild) {
    log.warn('Could not fetch guild — skipping action processing')
    return
  }

  for (const action of rows) {
    await processAction(action, guild, client)
  }
}

async function processAction(action, guild, client) {
  const { id, action_type, target_type, target_id, payload, actor_id } = action
  const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload || {}

  try {
    await query('UPDATE pending_actions SET status = ? WHERE id = ?', ['processing', id])

    await dispatch(action_type, target_type, target_id, parsed, actor_id, guild, client)

    await query(
      'UPDATE pending_actions SET status = ?, processed_at = NOW() WHERE id = ?',
      ['completed', id]
    )
    log.info({ actionId: id, action_type, target_id }, 'Action completed')
  } catch (err) {
    const detail = String(err.message || err).slice(0, 500)
    await query(
      'UPDATE pending_actions SET status = ?, error_detail = ?, processed_at = NOW() WHERE id = ?',
      ['failed', detail, id]
    ).catch(() => null)
    log.error({ err, actionId: id, action_type }, 'Action failed')
  }
}

async function dispatch(actionType, targetType, targetId, payload, actorId, guild, client) {
  switch (actionType) {
    case 'reassign_mentor':
      return handleReassignMentor(targetId, payload, actorId, guild)
    case 'close_ticket':
      return handleCloseTicket(targetId, actorId, guild, client)
    case 'escalate_ticket':
      return handleEscalateTicket(targetId, payload, actorId, guild)
    case 'reopen_ticket':
      return handleReopenTicket(targetId, actorId, guild)
    case 'force_close_ticket':
      return handleForceCloseTicket(targetId, guild)
    default:
      throw new Error(`Unknown action type: ${actionType}`)
  }
}

async function handleReassignMentor(prospectId, payload, actorId, guild) {
  const rows = await query('SELECT * FROM prospects WHERE id = ? AND status = ?', [prospectId, 'open'])
  const prospect = rows[0]
  if (!prospect) throw new Error(`Open prospect ${prospectId} not found`)

  await reassignMentor(prospect, payload.newMentorId, actorId, guild)
}

async function handleCloseTicket(ticketId, actorId, guild, client) {
  const rows = await query('SELECT * FROM tickets WHERE id = ? AND status = ?', [ticketId, 'open'])
  const ticket = rows[0]
  if (!ticket) throw new Error(`Open ticket ${ticketId} not found`)

  const channel = await guild.channels.fetch(ticket.channel_id).catch(() => null)
  if (!channel) throw new Error(`Ticket channel ${ticket.channel_id} not found`)

  await beginCloseGracePeriod(ticket, actorId, channel, client)
}

async function handleEscalateTicket(ticketId, payload, actorId, guild) {
  const rows = await query('SELECT * FROM tickets WHERE id = ?', [ticketId])
  const ticket = rows[0]
  if (!ticket) throw new Error(`Ticket ${ticketId} not found`)

  const channel = await guild.channels.fetch(ticket.channel_id).catch(() => null)
  if (!channel) throw new Error(`Ticket channel ${ticket.channel_id} not found`)

  const result = await escalateTicket(ticket, payload.tier, channel, actorId)
  if (result.error) throw new Error(result.error)
}

async function handleReopenTicket(ticketId, actorId) {
  const rows = await query('SELECT * FROM tickets WHERE id = ? AND status = ?', [ticketId, 'closing'])
  const ticket = rows[0]
  if (!ticket) throw new Error(`Closing ticket ${ticketId} not found`)

  await reopenTicket(ticket, actorId)
}

async function handleForceCloseTicket(ticketId, guild) {
  const rows = await query('SELECT * FROM tickets WHERE id = ? AND status = ?', [ticketId, 'closing'])
  const ticket = rows[0]
  if (!ticket) throw new Error(`Closing ticket ${ticketId} not found`)

  const channel = await guild.channels.fetch(ticket.channel_id).catch(() => null)
  if (!channel) {
    // Channel already gone — finalize in DB
    await query('UPDATE tickets SET status = ? WHERE id = ?', ['closed', ticketId])
    return
  }

  await forceCloseTicket(ticket, channel)
}
