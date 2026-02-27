import { PermissionFlagsBits } from 'discord.js';
import { errorEmbed } from './embed.js';

/**
 * Check if the interaction member has at least one of the required role IDs.
 */
export function hasAnyRole(member, roleIds) {
  if (!member || !roleIds?.length) return false;
  return roleIds.some((id) => member.roles.cache.has(id));
}

/**
 * Guard: if the user lacks all required roles, send an ephemeral error and return true (blocked).
 * Returns false if authorized (caller should proceed).
 */
export async function requireRole(interaction, roleIds) {
  if (hasAnyRole(interaction.member, roleIds)) return false;
  const reply = { embeds: [errorEmbed('You do not have permission to do this.')], flags: ['Ephemeral'] };
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(reply);
  } else {
    await interaction.reply(reply);
  }
  return true;
}

/**
 * Build a standard private-channel permission overwrite array.
 * Denies @everyone, allows the bot full access, and gives view+send to each role.
 */
export function buildPrivateChannelPermissions(guild, roleIds) {
  const overwrites = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: guild.client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageRoles,
      ],
    },
  ];

  for (const roleId of roleIds) {
    overwrites.push({
      id: roleId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
    });
  }

  return overwrites;
}
