import { query } from '../../database/connection.js'
import { createEmbed } from '../../utils/embed.js'
import { buildProspectInfoEmbed, buildProspectComponents, buildProspectAcceptedComponents } from './prospectEmbeds.js'
import { findBotMessageByCustomId } from '../../utils/messageSearch.js'
import logger from '../../logger.js'

const log = logger.child({ module: 'teamRole' })

const ROLE_PREFIX = 'Team '

/**
 * Find an existing "Team <name>" role for a mentor, matching by stored mentor ID
 * in the role's name pattern. We look up the mentor's display name and search roles.
 */
export async function getTeamRole(mentorId, guild) {
  const mentor = await guild.members.fetch(mentorId).catch(() => null)
  if (!mentor) return null

  const roleName = `${ROLE_PREFIX}${mentor.displayName}`
  return guild.roles.cache.find((r) => r.name === roleName) || null
}

/**
 * Find or create the "Team <DisplayName>" role for a mentor.
 */
export async function ensureTeamRole(mentorId, guild) {
  const mentor = await guild.members.fetch(mentorId).catch(() => null)
  if (!mentor) {
    log.warn({ mentorId }, 'Could not fetch mentor member')
    return null
  }

  const roleName = `${ROLE_PREFIX}${mentor.displayName}`
  let role = guild.roles.cache.find((r) => r.name === roleName)

  if (!role) {
    role = await guild.roles.create({
      name: roleName,
      reason: `Team role for mentor ${mentor.user.tag}`,
    })
    log.info({ mentorId, roleId: role.id, roleName }, 'Created team role')
  }

  return role
}

/**
 * Give a prospect the mentor's team role.
 */
export async function assignTeamRole(prospectUserId, mentorId, guild) {
  const role = await ensureTeamRole(mentorId, guild)
  if (!role) return

  const member = await guild.members.fetch(prospectUserId).catch(() => null)
  if (!member) {
    log.warn({ prospectUserId }, 'Could not fetch prospect member for team role assignment')
    return
  }

  await member.roles.add(role).catch((err) =>
    log.error({ err, prospectUserId, roleId: role.id }, 'Failed to add team role to prospect')
  )
  log.info({ prospectUserId, mentorId, roleId: role.id }, 'Assigned team role to prospect')
}

/**
 * Remove the mentor's team role from a prospect.
 */
export async function removeTeamRole(prospectUserId, mentorId, guild) {
  if (!mentorId) return

  const role = await getTeamRole(mentorId, guild)
  if (!role) return

  const member = await guild.members.fetch(prospectUserId).catch(() => null)
  if (!member) return

  await member.roles.remove(role).catch((err) =>
    log.error({ err, prospectUserId, roleId: role.id }, 'Failed to remove team role from prospect')
  )
  log.info({ prospectUserId, mentorId, roleId: role.id }, 'Removed team role from prospect')
}

/**
 * Delete the "Team <DisplayName>" role entirely.
 */
export async function deleteTeamRole(mentorId, guild) {
  const role = await getTeamRole(mentorId, guild)
  if (!role) return

  await role.delete(`Mentor ${mentorId} removed from mentor role`).catch((err) =>
    log.error({ err, mentorId, roleId: role.id }, 'Failed to delete team role')
  )
  log.info({ mentorId, roleId: role.id, roleName: role.name }, 'Deleted team role')
}

/**
 * Full mentor reassignment: remove old team role, update DB, add new team role,
 * update embeds, notify prospect.
 */
export async function reassignMentor(prospect, newMentorId, actorId, guild) {
  const oldMentorId = prospect.mentor_id

  // Remove old team role if there was a previous mentor
  if (oldMentorId) {
    await removeTeamRole(prospect.user_id, oldMentorId, guild)
  }

  // Update DB
  await query('UPDATE prospects SET mentor_id = ? WHERE id = ?', [newMentorId, prospect.id])

  // Add new team role
  await assignTeamRole(prospect.user_id, newMentorId, guild)

  // Resolve names for the event detail
  const oldMentor = oldMentorId
    ? await guild.members.fetch(oldMentorId).catch(() => null)
    : null
  const newMentor = await guild.members.fetch(newMentorId).catch(() => null)
  const oldTag = oldMentor?.user.tag || oldMentorId || 'none'
  const newTag = newMentor?.user.tag || newMentorId

  // Log event
  await query(
    'INSERT INTO prospect_events (prospect_id, event_type, actor_id, detail) VALUES (?, ?, ?, ?)',
    [prospect.id, 'mentor_reassigned', actorId, `Reassigned from ${oldTag} to ${newTag} via dashboard`]
  )

  // Update staff channel embed
  await refreshStaffEmbed(prospect, guild)

  // Notify the prospect via DM
  const user = await guild.client.users.fetch(prospect.user_id).catch(() => null)
  if (user) {
    const dmEmbed = createEmbed('Prospect')
      .setTitle('Mentor Changed')
      .setDescription(`Your mentor has been changed to **${newTag}**. They will be your new point of contact.`)
      .setColor(0x5865f2)
    await user.send({ embeds: [dmEmbed] }).catch(() => null)
  }

  // Notify in the staff channel
  const staffChannel = await guild.channels.fetch(prospect.channel_id).catch(() => null)
  if (staffChannel) {
    const notifEmbed = createEmbed('Prospect')
      .setTitle('Mentor Reassigned')
      .setDescription(`Mentor changed from **${oldTag}** to **${newTag}** (by dashboard).`)
      .setColor(0x5865f2)
    await staffChannel.send({ embeds: [notifEmbed] })
  }

  log.info({ prospectId: prospect.id, oldMentorId, newMentorId, actorId }, 'Mentor reassigned')
}

async function refreshStaffEmbed(prospect, guild) {
  const staffChannel = await guild.channels.fetch(prospect.channel_id).catch(() => null)
  if (!staffChannel) return

  const updated = (await query('SELECT * FROM prospects WHERE id = ?', [prospect.id]))[0]
  const member = await guild.members.fetch(updated.user_id).catch(() => null)
  const forumUrl = updated.forum_thread_id
    ? `https://discord.com/channels/${guild.id}/${updated.forum_thread_id}`
    : null
  const infoEmbed = buildProspectInfoEmbed(member, updated, forumUrl)
  const components = updated.forum_thread_id
    ? buildProspectAcceptedComponents(updated)
    : buildProspectComponents(updated)

  const topMsg = await findBotMessageByCustomId(staffChannel, guild.client.user.id, ['prospect_claim', 'prospect_accept', 'prospect_deny'])
  if (topMsg) {
    await topMsg.edit({ embeds: [infoEmbed], components })
  }
}
