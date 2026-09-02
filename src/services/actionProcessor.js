import { query } from '../database/connection.js'
import { beginCloseGracePeriod, escalateTicket, reopenTicket, forceCloseTicket } from './ticket/ticketService.js'
import { reassignMentor } from './prospect/teamRoleService.js'
import config from '../config.js'
import logger from '../logger.js'
import { reportError } from './admin/errorAlertService.js'

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
    reportError(err, { source: 'scheduler:actionProcessor:poll' }).catch(() => {})
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
    reportError(err, { source: `scheduler:actionProcessor:${action_type}` }).catch(() => {})
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
    case 'send_seeding_call':
      return handleSendSeedingCall(client)
    case 'send_seeding_rapport':
      return handleSendSeedingRapport(payload, client)
    case 'giveaway_start':
      return handleGiveawayStart(payload, actorId, client)
    case 'giveaway_open_vote':
      return handleGiveawayOpenVote(payload, client, guild)
    case 'giveaway_draw':
      return handleGiveawayDraw(client)
    case 'giveaway_cancel':
      return handleGiveawayCancel(client)
    case 'giveaway_add_entry':
      return handleGiveawayAddEntry(payload, actorId, client)
    case 'giveaway_refresh_entry':
      return handleGiveawayRefreshEntry(client)
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

  const result = await reopenTicket(ticket, actorId)
  if (result.error) throw new Error(result.error)
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

async function handleSendSeedingCall(client) {
  const { postSeedingCall, refreshActiveCall } = await import('./seeding/seedingScheduler.js')
  const { getSeedingConfig, getActiveSession } = await import('./seeding/seedingService.js')
  const cfg = await getSeedingConfig()
  if (!cfg?.enabled || !cfg.channel_id) throw new Error('Seeding not enabled or channel not configured')

  // Never create a second concurrent session. Active → refresh/re-post call only.
  const session = await getActiveSession()
  if (session) {
    await refreshActiveCall(client, cfg, session)
    return
  }

  // Staff override: new BEGUN + session; stamp last_daily_call_date so the clock
  // cannot post a second automatic BEGUN the same day.
  await postSeedingCall(client, cfg, { stampDailyCallDate: true })
}

async function handleSendSeedingRapport(payload, client) {
  const { getSeedingConfig, getSeedingRapport } = await import('./seeding/seedingService.js')
  const { buildSeedingRapportEmbed } = await import('./seeding/seedingEmbeds.js')

  const cfg = await getSeedingConfig()
  if (!cfg?.channel_id) throw new Error('Seeding channel not configured')

  const date = payload.date
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Missing or invalid date in payload')

  const rapport = await getSeedingRapport(date, cfg.tracker_server_id)

  const channel = await client.channels.fetch(cfg.channel_id).catch(() => null)
  if (!channel) throw new Error(`Seeding channel ${cfg.channel_id} not found`)

  const embed = buildSeedingRapportEmbed(rapport)
  await channel.send({ embeds: [embed] })
  log.info({ date }, 'Seeding rapport posted to Discord')
}

async function handleGiveawayStart(payload, actorId, client) {
  const { startGiveaway } = await import('./giveaway/giveawayActions.js')
  const prize = payload.prize
  const entryChannelId = payload.entryChannelId
  if (!prize || !entryChannelId) throw new Error('giveaway_start requires prize and entryChannelId')

  const rules = {}
  if (payload.windowDays != null) rules.windowDays = Number(payload.windowDays)
  if (payload.minHours != null) rules.minHours = Number(payload.minHours)
  if (payload.hoursWeight != null) rules.hoursWeight = Number(payload.hoursWeight)
  if (payload.seedWeight != null) rules.seedWeight = Number(payload.seedWeight)
  if (payload.voteWeight != null) rules.voteWeight = Number(payload.voteWeight)
  if (payload.votesPerVoter != null) rules.votesPerVoter = Number(payload.votesPerVoter)

  await startGiveaway({
    client,
    prize,
    channel: entryChannelId,
    createdBy: payload.discordUserId || actorId,
    monthLabel: payload.monthLabel || undefined,
    drawAt: payload.drawAt || undefined,
    rules,
  })
}

async function handleGiveawayOpenVote(payload, client, guild) {
  const { openGiveawayVote } = await import('./giveaway/giveawayActions.js')
  await openGiveawayVote({
    client,
    guild,
    channel: payload.channelId || undefined,
  })
}

async function handleGiveawayDraw(client) {
  const { drawGiveaway } = await import('./giveaway/giveawayActions.js')
  await drawGiveaway({ client })
}

async function handleGiveawayCancel(client) {
  const { cancelActiveGiveaway } = await import('./giveaway/giveawayActions.js')
  await cancelActiveGiveaway({ client })
}

async function handleGiveawayAddEntry(payload, actorId, client) {
  const { addManualGiveawayEntry } = await import('./giveaway/giveawayActions.js')
  if (!payload.userId) throw new Error('giveaway_add_entry requires userId')
  await addManualGiveawayEntry({
    client,
    userId: String(payload.userId),
    hours: Number(payload.hours) || 0,
    seed: Number(payload.seed) || 0,
    addedBy: payload.discordUserId || actorId,
  })
}

async function handleGiveawayRefreshEntry(client) {
  const { refreshActiveEntryMessage } = await import('./giveaway/giveawayActions.js')
  await refreshActiveEntryMessage({ client })
}
