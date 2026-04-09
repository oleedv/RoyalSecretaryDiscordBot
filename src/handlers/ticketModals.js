import { validateSteamInput } from '../services/steamService.js';
import { createTicket } from '../services/ticket/ticketService.js';
import { getStoredSteamId, linkSteamId } from '../services/userService.js';
import { errorEmbed, successEmbed, infoEmbed } from '../utils/embed.js';
import config from '../config.js';
import logger from '../logger.js';

const log = logger.child({ module: 'ticketModals' });

function extractTier(interaction) {
  const field = interaction.fields.getField('ticket_teams');
  return field.value ?? field.values?.[0] ?? 'normal';
}

async function validateMembership(interaction, tier) {
  if (tier === 'normal') return null;
  const memberRoleId = config.tickets.memberRoleId;
  log.info({ tier, memberRoleId, hasMember: !!interaction.member, userId: interaction.user.id }, 'validateMembership: start');

  if (!memberRoleId) return 'You need to be a member to create Community Officer/Admin Officer tickets. Please select Normal instead.';

  let member = interaction.member;
  if (!member) {
    const guild = await interaction.client.guilds.fetch(config.guild.id).catch(() => null);
    log.info({ guildFound: !!guild }, 'validateMembership: fetched guild');
    member = guild ? await guild.members.fetch(interaction.user.id).catch(() => null) : null;
    log.info({ memberFound: !!member, roleIds: member?.roles?.cache?.map(r => r.id) }, 'validateMembership: fetched member');
  } else {
    log.info({ roleIds: member.roles?.cache?.map(r => r.id) }, 'validateMembership: using interaction.member');
  }

  if (!member?.roles?.cache?.has(memberRoleId)) {
    const purgedRoleId = config.purged?.roleId;
    if (purgedRoleId && member?.roles?.cache?.has(purgedRoleId) && tier === 'community_officer') {
      return null;
    }
    return 'You need to be a member to create Community Officer/Admin Officer tickets. Please select Normal instead.';
  }
  return null;
}

async function createTicketFromModal(interaction, { tierOverride, useStoredSteam = false } = {}) {
  const tier = tierOverride ?? extractTier(interaction);
  const memberError = await validateMembership(interaction, tier);
  if (memberError) {
    return interaction.reply({ embeds: [errorEmbed(memberError)], flags: ['Ephemeral'] });
  }

  let steamId;
  if (useStoredSteam) {
    await interaction.deferReply({ flags: ['Ephemeral'] });
    steamId = await getStoredSteamId(interaction.user.id);
    if (!steamId) {
      return interaction.editReply({ embeds: [errorEmbed('Could not retrieve your stored Steam ID. Please try again.')] });
    }
  } else {
    const steamInput = interaction.fields.getTextInputValue('ticket_steam_id').trim();
    const steamValidation = validateSteamInput(steamInput);
    if (!steamValidation.valid) {
      return interaction.reply({
        embeds: [errorEmbed(`**Steam ID**: ${steamValidation.reason}`)],
        flags: ['Ephemeral'],
      });
    }
    steamId = steamValidation.steamId;
    await interaction.deferReply({ flags: ['Ephemeral'] });
  }

  const reason = interaction.fields.getTextInputValue('ticket_reason').trim();
  const guild = interaction.guild ?? await interaction.client.guilds.fetch(config.guild.id);
  const result = await createTicket(interaction.user.id, guild, { steamId, reason, tier });
  if (result.error) {
    return interaction.editReply({ embeds: [errorEmbed(result.error)] });
  }

  const user = await interaction.client.users.fetch(interaction.user.id).catch(() => null);
  if (user) {
    await user.send({ embeds: [infoEmbed('Your ticket has been created. A staff member will be with you shortly.\n\nFeel free to send any additional details, screenshots, or information here while you wait - it helps us resolve your issue faster.')] }).catch(() => null);
  }

  await interaction.editReply({
    embeds: [successEmbed(`Ticket created! Check your DMs. Channel: <#${result.channel.id}>`)],
  });

  if (!useStoredSteam) {
    linkSteamId(interaction.user.id, steamId, interaction.user.username);
  }

  log.info({ userId: interaction.user.id, channelId: result.channel.id, tier }, 'Ticket created via modal');
}

export async function handleCreateModal(interaction) {
  return createTicketFromModal(interaction);
}

export async function handleCreateModalQuick(interaction) {
  return createTicketFromModal(interaction, { useStoredSteam: true });
}

export async function handlePurgedModal(interaction) {
  return createTicketFromModal(interaction, { tierOverride: 'community_officer' });
}

export async function handlePurgedModalQuick(interaction) {
  return createTicketFromModal(interaction, { tierOverride: 'community_officer', useStoredSteam: true });
}
