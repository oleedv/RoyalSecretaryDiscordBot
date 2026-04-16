import { isTrackedChannel, isOwner, checkRateLimit, logEvent } from '../services/tempvoice/tempvoiceManager.js';
import { touchActivity, updatePresetField } from '../services/tempvoice/tempvoiceService.js';
import { getSafeChannelName } from '../services/tempvoice/contentFilter.js';
import { errorEmbed, successEmbed } from '../utils/embed.js';
import { PermissionFlagsBits } from 'discord.js';

function checkAccess(interaction, channelId) {
  if (isOwner(channelId, interaction.user.id)) return true;
  if (interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  interaction.reply({ embeds: [errorEmbed('Only the channel owner can do this.')], flags: ['Ephemeral'] });
  return false;
}

export async function handleNameModal(interaction) {
  const vc = interaction.member.voice.channel;
  if (!vc || !isTrackedChannel(vc.id)) {
    return interaction.reply({ embeds: [errorEmbed('You must be in a temporary voice channel.')], flags: ['Ephemeral'] });
  }
  if (!checkAccess(interaction, vc.id)) return;

  const input = interaction.fields.getTextInputValue('tv_name_input');
  const { safe, name } = getSafeChannelName(input);

  if (!safe) {
    return interaction.reply({ embeds: [errorEmbed('That name is not allowed. Please choose a different name.')], flags: ['Ephemeral'] });
  }

  await vc.setName(name);
  if (isOwner(vc.id, interaction.user.id)) await updatePresetField(interaction.user.id, interaction.guild.id, 'channel_name', name).catch(() => null);
  await interaction.reply({ embeds: [successEmbed(`Channel renamed to **${name}**.`)], flags: ['Ephemeral'] });
  await logEvent(interaction.guild, 'Channel Renamed', `<@${interaction.user.id}> renamed channel to **${name}**`);
  touchActivity(vc.id).catch(() => null);
}

export async function handleLimitModal(interaction) {
  const vc = interaction.member.voice.channel;
  if (!vc || !isTrackedChannel(vc.id)) {
    return interaction.reply({ embeds: [errorEmbed('You must be in a temporary voice channel.')], flags: ['Ephemeral'] });
  }
  if (!checkAccess(interaction, vc.id)) return;

  const input = interaction.fields.getTextInputValue('tv_limit_input');
  const limit = parseInt(input, 10);

  if (isNaN(limit) || limit < 0 || limit > 99) {
    return interaction.reply({ embeds: [errorEmbed('User limit must be a number between 0 and 99.')], flags: ['Ephemeral'] });
  }

  await vc.setUserLimit(limit);
  if (isOwner(vc.id, interaction.user.id)) await updatePresetField(interaction.user.id, interaction.guild.id, 'user_limit', limit).catch(() => null);
  const display = limit === 0 ? 'unlimited' : `${limit} users`;
  await interaction.reply({ embeds: [successEmbed(`User limit set to **${display}**.`)], flags: ['Ephemeral'] });
  touchActivity(vc.id).catch(() => null);
}
