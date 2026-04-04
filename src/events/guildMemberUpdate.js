import { Events } from 'discord.js'
import { getOpenProspectsByMentor, unclaimProspect } from '../services/prospect/prospectService.js'
import { ensureTeamRole, deleteTeamRole, removeTeamRole } from '../services/prospect/teamRoleService.js'
import config from '../config.js'
import logger from '../logger.js'

const log = logger.child({ module: 'memberUpdate' })

export default {
  name: Events.GuildMemberUpdate,

  async execute(oldMember, newMember) {
    const mentorRoleId = config.prospects.mentorRoleId
    if (!mentorRoleId) return

    const hadRole = oldMember.roles.cache.has(mentorRoleId)
    const hasRole = newMember.roles.cache.has(mentorRoleId)

    if (hadRole === hasRole) return // no change to mentor role

    const guild = newMember.guild

    try {
      if (!hadRole && hasRole) {
        // Mentor role ADDED — create team role
        log.info({ userId: newMember.id }, 'Mentor role added — creating team role')
        await ensureTeamRole(newMember.id, guild)
      } else if (hadRole && !hasRole) {
        // Mentor role REMOVED — unclaim prospects, delete team role
        log.info({ userId: oldMember.id }, 'Mentor role removed — unclaiming prospects and deleting team role')

        const prospects = await getOpenProspectsByMentor(oldMember.id)
        for (const prospect of prospects) {
          try {
            await removeTeamRole(prospect.user_id, oldMember.id, guild)
            await unclaimProspect(prospect, oldMember.id, guild)
          } catch (err) {
            log.error({ err, prospectId: prospect.id, mentorId: oldMember.id }, 'Failed to unclaim prospect during mentor role removal')
          }
        }

        await deleteTeamRole(oldMember.id, guild)
      }
    } catch (err) {
      log.error({ err, userId: newMember.id }, 'Error handling mentor role change')
    }
  },
}
