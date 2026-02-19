import { PermissionFlagsBits } from 'discord.js';

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
