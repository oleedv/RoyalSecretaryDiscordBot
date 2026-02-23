import { validateSteamInput } from '../services/steamService.js';
import { createTicket } from '../services/ticket/ticketService.js';
import { getStoredSteamId, linkSteamId } from '../services/userService.js';
import { errorEmbed, successEmbed, infoEmbed } from '../utils/embed.js';
import config from '../config.js';
import logger from '../logger.js';

const log = logger.child({ module: 'ticketModals' });

export async function handleCreateModal(interaction) {
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
  });
  if (result.error) {
    return interaction.editReply({ embeds: [errorEmbed(result.error)] });
  }

  const user = await interaction.client.users.fetch(interaction.user.id).catch(() => null);
  if (user) {
    await user.send({ embeds: [infoEmbed('Your ticket has been created. A staff member will be with you shortly.\n\nFeel free to send any additional details, screenshots, or information here while you wait — it helps us resolve your issue faster.')] }).catch(() => null);
  }

  await interaction.editReply({
    embeds: [successEmbed(`Ticket created! Check your DMs. Channel: <#${result.channel.id}>`)],
  });

  linkSteamId(interaction.user.id, steamValidation.steamId);
  log.info({ userId: interaction.user.id, channelId: result.channel.id }, 'Ticket created via modal');
}

export async function handleCreateModalQuick(interaction) {
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
  });
  if (result.error) {
    return interaction.editReply({ embeds: [errorEmbed(result.error)] });
  }

  const user = await interaction.client.users.fetch(interaction.user.id).catch(() => null);
  if (user) {
    await user.send({ embeds: [infoEmbed('Your ticket has been created. A staff member will be with you shortly.\n\nFeel free to send any additional details, screenshots, or information here while you wait — it helps us resolve your issue faster.')] }).catch(() => null);
  }

  await interaction.editReply({
    embeds: [successEmbed(`Ticket created! Check your DMs. Channel: <#${result.channel.id}>`)],
  });

  log.info({ userId: interaction.user.id, channelId: result.channel.id }, 'Ticket created via quick modal (stored Steam ID)');
}
