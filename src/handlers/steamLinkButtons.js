import { rawModal, labelComponent, textInput, radioGroup } from '../utils/modalComponents.js';
import { successEmbed, errorEmbed } from '../utils/embed.js';
import { validateSteamInput } from '../services/steamService.js';
import { getStoredSteamId, getDiscordIdBySteamId, linkSteamId } from '../services/userService.js';
import { evaluateLinkSubmission } from '../services/steamLink.js';
import logger from '../logger.js';

const log = logger.child({ module: 'steamLinkButtons' });

export async function handleLinkStart(interaction) {
  const modal = rawModal('link_steam_modal', 'Link your Steam account', [
    labelComponent(
      'Your Steam ID',
      textInput('steam_id', 'short', {
        placeholder: '76561198012345678 or steamcommunity.com/profiles/...',
        required: true,
      }),
      { description: 'Your Steam64 ID or the URL of your Steam profile.' }
    ),
    labelComponent(
      'Is this your Steam account?',
      radioGroup('is_mine', [
        { label: 'Yes', value: 'Yes' },
        { label: 'No', value: 'No' },
      ])
    ),
  ]);

  await interaction.showModal(modal);
}

export async function handleLinkSubmit(interaction) {
  await interaction.deferReply({ flags: ['Ephemeral'] });

  const isMine = interaction.fields.getField('is_mine')?.value ?? '';
  const steamInput = interaction.fields.getTextInputValue('steam_id').trim();
  const userId = interaction.user.id;

  const validation = validateSteamInput(steamInput);

  let currentLink = null;
  let steamIdOwner = null;
  if (validation.valid) {
    currentLink = await getStoredSteamId(userId);
    steamIdOwner = await getDiscordIdBySteamId(validation.steamId);
  }

  const decision = evaluateLinkSubmission({ isMine, validation, currentLink, steamIdOwner, userId });
  if (!decision.ok) {
    return interaction.editReply({ embeds: [errorEmbed(decision.error)] });
  }

  await linkSteamId(userId, decision.steamId, interaction.user.username);
  log.info({ userId, steamId: decision.steamId }, 'User linked Steam ID via DM');

  return interaction.editReply({
    embeds: [successEmbed(
      `Linked! Your Steam ID \`${decision.steamId}\` is now connected. `
      + 'You can now enter the giveaway and earn seeding rewards.'
    )],
  });
}
