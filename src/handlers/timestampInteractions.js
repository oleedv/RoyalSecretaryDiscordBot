import {
  renderCode,
  isValidStyle,
  buildPreviewText,
  buildComponents,
  parsePostCustomId,
  parseStyleSelectCustomId,
} from '../services/timestamp/timestampView.js';
import { clearUserTimezone } from '../services/timestamp/timestampService.js';
import { errorEmbed, successEmbed } from '../utils/embed.js';
import logger from '../logger.js';

const log = logger.child({ module: 'timestampInteractions' });

/** Style dropdown changed: re-render with the newly selected style as the Post target. */
export async function handleStyleSelect(interaction) {
  const parsed = parseStyleSelectCustomId(interaction.customId);
  const style = interaction.values?.[0];
  if (!parsed || !isValidStyle(style)) {
    return interaction.reply({ embeds: [errorEmbed('That timestamp expired — run `/timestamp` again.')], flags: ['Ephemeral'] });
  }

  const content =
    interaction.message.content || buildPreviewText(parsed.unix);
  await interaction.update({ content, components: buildComponents(parsed.unix, style) });
}

/** "Post to this channel" pressed: drop the chosen timestamp into the channel. */
export async function handlePostButton(interaction) {
  const parsed = parsePostCustomId(interaction.customId);
  if (!parsed) {
    return interaction.reply({ embeds: [errorEmbed('That timestamp expired — run `/timestamp` again.')], flags: ['Ephemeral'] });
  }

  const code = renderCode(parsed.unix, parsed.style);
  try {
    await interaction.channel.send({ content: code });
  } catch (err) {
    log.warn({ err, channelId: interaction.channel?.id }, 'failed to post timestamp to channel');
    return interaction.reply({
      embeds: [errorEmbed('I couldn\'t post in this channel (missing permission?). You can still copy the code from the message above.')],
      flags: ['Ephemeral'],
    });
  }

  await interaction.reply({ embeds: [successEmbed(`Posted ${code} to this channel.`)], flags: ['Ephemeral'] });
}

/** "Clear my timezone" pressed on the /timezone reply. */
export async function handleClearTimezone(interaction) {
  await clearUserTimezone(interaction.user.id);
  await interaction.update({ embeds: [successEmbed('Your saved timezone has been cleared.')], components: [] });
}
