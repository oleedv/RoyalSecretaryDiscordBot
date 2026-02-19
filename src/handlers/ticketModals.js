import { validateSteamInput } from '../services/steamService.js';
import { createTicket } from '../services/ticket/ticketService.js';
import logger from '../logger.js';

const log = logger.child({ module: 'ticketModals' });

export async function handleCreateModal(interaction) {
  const steamInput = interaction.fields.getTextInputValue('ticket_steam_id').trim();
  const reason = interaction.fields.getTextInputValue('ticket_reason').trim();

  const steamValidation = validateSteamInput(steamInput);
  if (!steamValidation.valid) {
    return interaction.reply({
      content: `**Steam ID**: ${steamValidation.reason}`,
      flags: ['Ephemeral'],
    });
  }

  await interaction.deferReply({ flags: ['Ephemeral'] });

  const result = await createTicket(interaction.user.id, interaction.guild, {
    steamId: steamValidation.steamId,
    reason,
  });
  if (result.error) {
    return interaction.editReply({ content: result.error });
  }

  const user = await interaction.client.users.fetch(interaction.user.id).catch(() => null);
  if (user) {
    await user.send(
      `**[Ticket]** Your ticket has been created. A staff member will be with you shortly.`
    ).catch(() => null);
  }

  await interaction.editReply({
    content: `Ticket created! Check your DMs. Channel: <#${result.channel.id}>`,
  });

  log.info({ userId: interaction.user.id, channelId: result.channel.id }, 'Ticket created via modal');
}
