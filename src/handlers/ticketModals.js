import { validateSteamInput } from '../services/steamService.js';
import { createTicket } from '../services/ticket/ticketService.js';
import { getStoredSteamId, linkSteamId } from '../services/userService.js';
import { errorEmbed, successEmbed, infoEmbed } from '../utils/embed.js';
import config from '../config.js';
import logger from '../logger.js';

const log = logger.child({ module: 'ticketModals' });

function extractTier(interaction) {
  const field = interaction.fields.getField('ticket_teams');
  return field.values?.[0] ?? 'normal';
}

function validateMembership(interaction, tier) {
  if (tier === 'normal') return null;
  const memberRoles = interaction.member?.roles?.cache;
  const normalRoles = config.tickets.roles.normal || [];
  const isMember = memberRoles && normalRoles.some((r) => memberRoles.has(r));
  if (!isMember) {
    return 'You need to be a member to create CO/Admin tickets. Please select Normal instead.';
  }
  return null;
}

async function createWithSteamInput(interaction) {
  const tier = extractTier(interaction);
  const memberError = validateMembership(interaction, tier);
  if (memberError) {
    return interaction.reply({ embeds: [errorEmbed(memberError)], flags: ['Ephemeral'] });
  }

  const steamInput = interaction.fields.getTextInputValue('ticket_steam_id').trim();
  const reason = interaction.fields.getTextInputValue('ticket_reason').trim();

  const steamValidation = validateSteamInput(steamInput);
  if (!steamValidation.valid) {
    return interaction.reply({
      embeds: [errorEmbed(`**Steam ID**: ${steamValidation.reason}`)],
      flags: ['Ephemeral'],
    });
  }

  await interaction.deferReply({ flags: ['Ephemeral'] });

  const guild = interaction.guild ?? await interaction.client.guilds.fetch(config.guild.id);
  const result = await createTicket(interaction.user.id, guild, {
    steamId: steamValidation.steamId,
    reason,
    tier,
  });
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

  linkSteamId(interaction.user.id, steamValidation.steamId);
  log.info({ userId: interaction.user.id, channelId: result.channel.id, tier }, 'Ticket created via modal');
}

async function createWithStoredSteam(interaction) {
  const tier = extractTier(interaction);
  const memberError = validateMembership(interaction, tier);
  if (memberError) {
    return interaction.reply({ embeds: [errorEmbed(memberError)], flags: ['Ephemeral'] });
  }

  const reason = interaction.fields.getTextInputValue('ticket_reason').trim();

  await interaction.deferReply({ flags: ['Ephemeral'] });

  const steamId = await getStoredSteamId(interaction.user.id);
  if (!steamId) {
    return interaction.editReply({ embeds: [errorEmbed('Could not retrieve your stored Steam ID. Please try again.')] });
  }

  const guild = interaction.guild ?? await interaction.client.guilds.fetch(config.guild.id);
  const result = await createTicket(interaction.user.id, guild, {
    steamId,
    reason,
    tier,
  });
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

  log.info({ userId: interaction.user.id, channelId: result.channel.id, tier }, 'Ticket created via quick modal');
}

export async function handleCreateModal(interaction) {
  return createWithSteamInput(interaction);
}

export async function handleCreateModalQuick(interaction) {
  return createWithStoredSteam(interaction);
}
