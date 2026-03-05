import { createEmbed } from '../utils/embed.js';
import { getOpenProspectsByMentor, unclaimProspect } from '../services/prospect/prospectService.js';
import { removeTeamRole, deleteTeamRole } from '../services/prospect/teamRoleService.js';
import logger from '../logger.js';

const log = logger.child({ module: 'memberLeave' });

export async function handleTicketMemberLeave(ticket, member, guild) {
  const channel = await guild.channels.fetch(ticket.channel_id).catch(() => null);
  if (!channel) return;

  const embed = createEmbed('Ticket')
    .setTitle('Member Left Server')
    .setDescription(`**${member.user.tag}** has left the server. This ticket is still open.`)
    .setColor(0xed4245);

  await channel.send({ embeds: [embed] });
  log.info({ ticketId: ticket.id, userId: member.id }, 'Notified staff of ticket user leaving');
}

export async function handleProspectMemberLeave(prospect, member, guild) {
  const channel = await guild.channels.fetch(prospect.channel_id).catch(() => null);
  if (!channel) return;

  const embed = createEmbed('Prospect')
    .setTitle('Prospect Left Server')
    .setDescription(`**${prospect.alias}** (${member.user.tag}) has left the server. This prospect is still open.`)
    .setColor(0xed4245);

  await channel.send({ embeds: [embed] });
  log.info({ prospectId: prospect.id, userId: member.id }, 'Notified staff of prospect leaving');
}

export async function handleMentorLeave(userId, guild) {
  const prospects = await getOpenProspectsByMentor(userId);
  for (const prospect of prospects) {
    await removeTeamRole(prospect.user_id, userId, guild)
    await unclaimProspect(prospect, userId, guild);
    log.info({ prospectId: prospect.id, mentorId: userId }, 'Auto-unclaimed mentor who left server');
  }
  // Delete the team role since the mentor is gone
  await deleteTeamRole(userId, guild)
}
