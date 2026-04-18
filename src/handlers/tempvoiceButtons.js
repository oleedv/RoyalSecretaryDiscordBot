import {
  ActionRowBuilder, StringSelectMenuBuilder, UserSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  PermissionFlagsBits, ComponentType,
} from 'discord.js';
import {
  isTrackedChannel, isOwner, getOwner, checkRateLimit,
  transferOwnership, claimChannel, deleteChannelByInteraction, logEvent,
} from '../services/tempvoice/tempvoiceManager.js';
import { touchActivity, updatePresetField } from '../services/tempvoice/tempvoiceService.js';
import { errorEmbed, successEmbed } from '../utils/embed.js';
import logger from '../logger.js';

const log = logger.child({ module: 'tempvoice-buttons' });

const COLLECTOR_TIMEOUT = 15_000;

// ── Helpers ──

function getVoiceChannel(interaction) {
  const vc = interaction.member.voice.channel;
  if (!vc) {
    interaction.reply({ embeds: [errorEmbed('You must be in a voice channel.')], flags: ['Ephemeral'] });
    return null;
  }
  if (!isTrackedChannel(vc.id)) {
    interaction.reply({ embeds: [errorEmbed('This is not a temporary voice channel.')], flags: ['Ephemeral'] });
    return null;
  }
  return vc;
}

function checkAccess(interaction, channelId) {
  if (isOwner(channelId, interaction.user.id)) return true;
  if (interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  interaction.reply({ embeds: [errorEmbed('Only the channel owner can do this.')], flags: ['Ephemeral'] });
  return false;
}

function checkRate(interaction) {
  const result = checkRateLimit(interaction.user.id);
  if (!result.allowed) {
    interaction.reply({ embeds: [errorEmbed(`Rate limited. Try again in ${result.retryAfter}s.`)], flags: ['Ephemeral'] });
    return false;
  }
  return true;
}

// ── Name (modal) ──

export async function handleName(interaction) {
  const vc = getVoiceChannel(interaction);
  if (!vc) return;
  if (!checkAccess(interaction, vc.id)) return;
  if (!checkRate(interaction)) return;

  const modal = new ModalBuilder()
    .setCustomId('tv_name_modal')
    .setTitle('Rename Channel')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('tv_name_input')
          .setLabel('New channel name')
          .setStyle(TextInputStyle.Short)
          .setMinLength(2)
          .setMaxLength(100)
          .setPlaceholder('Enter a new name...')
          .setRequired(true),
      ),
    );

  await interaction.showModal(modal);
}

// ── Limit (modal) ──

export async function handleLimit(interaction) {
  const vc = getVoiceChannel(interaction);
  if (!vc) return;
  if (!checkAccess(interaction, vc.id)) return;
  if (!checkRate(interaction)) return;

  const modal = new ModalBuilder()
    .setCustomId('tv_limit_modal')
    .setTitle('Set User Limit')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('tv_limit_input')
          .setLabel('User limit (0 = unlimited, max 99)')
          .setStyle(TextInputStyle.Short)
          .setMinLength(1)
          .setMaxLength(2)
          .setPlaceholder('0')
          .setRequired(true),
      ),
    );

  await interaction.showModal(modal);
}

// ── Privacy (select menu) ──

export async function handlePrivacy(interaction) {
  const vc = getVoiceChannel(interaction);
  if (!vc) return;
  if (!checkAccess(interaction, vc.id)) return;
  if (!checkRate(interaction)) return;

  const menu = new StringSelectMenuBuilder()
    .setCustomId('tv_privacy_select')
    .setPlaceholder('Choose a privacy setting...')
    .addOptions(
      { label: 'Lock', description: 'Only trusted members can join', value: 'lock', emoji: '\u{1F512}' },
      { label: 'Unlock', description: 'Everyone can join', value: 'unlock', emoji: '\u{1F513}' },
      { label: 'Invisible', description: 'Only trusted members can see the channel', value: 'invisible', emoji: '\u{1F441}\uFE0F' },
      { label: 'Visible', description: 'Everyone can see the channel', value: 'visible', emoji: '\u{1F4E2}' },
      { label: 'Close Chat', description: 'Only trusted members can send messages', value: 'closechat', emoji: '\u{1F4AD}' },
      { label: 'Open Chat', description: 'Everyone can send messages', value: 'openchat', emoji: '\u{1F4AC}' },
    );

  const row = new ActionRowBuilder().addComponents(menu);
  const reply = await interaction.reply({ content: 'Select a privacy setting:', components: [row], flags: ['Ephemeral'], fetchReply: true });

  try {
    const collected = await reply.awaitMessageComponent({ componentType: ComponentType.StringSelect, time: COLLECTOR_TIMEOUT });
    const value = collected.values[0];
    const guildId = interaction.guild.id;

    switch (value) {
      case 'lock':
        await vc.permissionOverwrites.edit(guildId, { Connect: false });
        if (isOwner(vc.id, interaction.user.id)) await updatePresetField(interaction.user.id, guildId, 'is_locked', 1).catch(() => null);
        break;
      case 'unlock':
        await vc.permissionOverwrites.edit(guildId, { Connect: true });
        if (isOwner(vc.id, interaction.user.id)) await updatePresetField(interaction.user.id, guildId, 'is_locked', 0).catch(() => null);
        break;
      case 'invisible':
        await vc.permissionOverwrites.edit(guildId, { ViewChannel: false });
        if (isOwner(vc.id, interaction.user.id)) await updatePresetField(interaction.user.id, guildId, 'is_invisible', 1).catch(() => null);
        break;
      case 'visible':
        await vc.permissionOverwrites.edit(guildId, { ViewChannel: true });
        if (isOwner(vc.id, interaction.user.id)) await updatePresetField(interaction.user.id, guildId, 'is_invisible', 0).catch(() => null);
        break;
      case 'closechat':
        await vc.permissionOverwrites.edit(guildId, { SendMessages: false });
        if (isOwner(vc.id, interaction.user.id)) await updatePresetField(interaction.user.id, guildId, 'is_chat_closed', 1).catch(() => null);
        break;
      case 'openchat':
        await vc.permissionOverwrites.edit(guildId, { SendMessages: true });
        if (isOwner(vc.id, interaction.user.id)) await updatePresetField(interaction.user.id, guildId, 'is_chat_closed', 0).catch(() => null);
        break;
    }

    await collected.update({ content: `Privacy set to **${value}**.`, components: [] });
    await logEvent(interaction.guild, 'Privacy Changed', `<@${interaction.user.id}> set **${vc.name}** privacy to **${value}**`);
    touchActivity(vc.id).catch(() => null);
  } catch {
    await interaction.editReply({ content: 'Selection timed out.', components: [] }).catch(() => null);
  }
}

// ── DND (toggle) ──

export async function handleDnd(interaction) {
  const vc = getVoiceChannel(interaction);
  if (!vc) return;
  if (!checkAccess(interaction, vc.id)) return;
  if (!checkRate(interaction)) return;

  const guildId = interaction.guild.id;
  const overwrite = vc.permissionOverwrites.cache.get(guildId);
  const isDndActive = overwrite?.deny.has(PermissionFlagsBits.Speak);

  const perms = {
    Speak: isDndActive ? null : false,
    Stream: isDndActive ? null : false,
    UseVAD: isDndActive ? null : false,
    PrioritySpeaker: isDndActive ? null : false,
    UseSoundboard: isDndActive ? null : false,
    UseEmbeddedActivities: isDndActive ? null : false,
  };

  await vc.permissionOverwrites.edit(guildId, perms);
  const state = isDndActive ? 'disabled' : 'enabled';
  if (isOwner(vc.id, interaction.user.id)) await updatePresetField(interaction.user.id, guildId, 'is_dnd', isDndActive ? 0 : 1).catch(() => null);
  await interaction.reply({ embeds: [successEmbed(`DND mode **${state}**.`)], flags: ['Ephemeral'] });
  await logEvent(interaction.guild, 'DND Toggled', `<@${interaction.user.id}> ${state} DND mode in **${vc.name}**`);
  touchActivity(vc.id).catch(() => null);
}

// ── Region (select menu) ──

export async function handleRegion(interaction) {
  const vc = getVoiceChannel(interaction);
  if (!vc) return;
  if (!checkAccess(interaction, vc.id)) return;
  if (!checkRate(interaction)) return;

  const regions = [
    { label: 'Auto', value: 'auto' },
    { label: 'US East', value: 'us-east' },
    { label: 'US West', value: 'us-west' },
    { label: 'US Central', value: 'us-central' },
    { label: 'US South', value: 'us-south' },
    { label: 'Brazil', value: 'brazil' },
    { label: 'Singapore', value: 'singapore' },
    { label: 'Sydney', value: 'sydney' },
    { label: 'Russia', value: 'russia' },
    { label: 'South Africa', value: 'south-africa' },
    { label: 'Hong Kong', value: 'hongkong' },
    { label: 'India', value: 'india' },
    { label: 'Japan', value: 'japan' },
    { label: 'Rotterdam', value: 'rotterdam' },
    { label: 'South Korea', value: 'south-korea' },
  ];

  const menu = new StringSelectMenuBuilder()
    .setCustomId('tv_region_select')
    .setPlaceholder('Choose a voice region...')
    .addOptions(regions);

  const row = new ActionRowBuilder().addComponents(menu);

  let reply;
  try {
    reply = await interaction.reply({ content: 'Select a voice region:', components: [row], flags: ['Ephemeral'], fetchReply: true });
    log.info({ channelId: vc.id }, 'Region select menu sent');
  } catch (err) {
    log.error({ err, channelId: vc.id }, 'Failed to send region select menu');
    return;
  }

  try {
    const collected = await reply.awaitMessageComponent({ componentType: ComponentType.StringSelect, time: COLLECTOR_TIMEOUT });
    const region = collected.values[0];
    log.info({ region, channelId: vc.id }, 'Region selected');
    try {
      await vc.setRTCRegion(region === 'auto' ? null : region);
      if (isOwner(vc.id, interaction.user.id)) await updatePresetField(interaction.user.id, interaction.guild.id, 'region', region).catch(() => null);
      await collected.update({ content: `Voice region set to **${region}**.`, components: [] });
      log.info({ region, channelId: vc.id }, 'Region set successfully');
      touchActivity(vc.id).catch(() => null);
    } catch (err) {
      log.error({ err, region, channelId: vc.id }, 'Failed to set voice region');
      await collected.update({ content: `Failed to set region to **${region}**.`, components: [] });
    }
  } catch (err) {
    log.warn({ err: err?.message, channelId: vc.id }, 'Region collector ended');
    await interaction.editReply({ content: 'Selection timed out.', components: [] }).catch(() => null);
  }
}

// ── Trust (user select) ──

export async function handleTrust(interaction) {
  const vc = getVoiceChannel(interaction);
  if (!vc) return;
  if (!checkAccess(interaction, vc.id)) return;
  if (!checkRate(interaction)) return;

  const menu = new UserSelectMenuBuilder().setCustomId('tv_trust_select').setPlaceholder('Select a user to trust...');
  const row = new ActionRowBuilder().addComponents(menu);
  const reply = await interaction.reply({ content: 'Select a user to grant access:', components: [row], flags: ['Ephemeral'], fetchReply: true });

  try {
    const collected = await reply.awaitMessageComponent({ componentType: ComponentType.UserSelect, time: COLLECTOR_TIMEOUT });
    const targetId = collected.values[0];

    await vc.permissionOverwrites.edit(targetId, { ViewChannel: true, Connect: true, SendMessages: true });
    await collected.update({ content: `<@${targetId}> is now trusted.`, components: [] });
    await logEvent(interaction.guild, 'User Trusted', `<@${interaction.user.id}> trusted <@${targetId}> in **${vc.name}**`);
    touchActivity(vc.id).catch(() => null);
  } catch {
    await interaction.editReply({ content: 'Selection timed out.', components: [] }).catch(() => null);
  }
}

// ── Untrust (user select) ──

export async function handleUntrust(interaction) {
  const vc = getVoiceChannel(interaction);
  if (!vc) return;
  if (!checkAccess(interaction, vc.id)) return;
  if (!checkRate(interaction)) return;

  const menu = new UserSelectMenuBuilder().setCustomId('tv_untrust_select').setPlaceholder('Select a user to untrust...');
  const row = new ActionRowBuilder().addComponents(menu);
  const reply = await interaction.reply({ content: 'Select a user to revoke access:', components: [row], flags: ['Ephemeral'], fetchReply: true });

  try {
    const collected = await reply.awaitMessageComponent({ componentType: ComponentType.UserSelect, time: COLLECTOR_TIMEOUT });
    const targetId = collected.values[0];

    await vc.permissionOverwrites.delete(targetId).catch(() => null);
    await collected.update({ content: `<@${targetId}> is no longer trusted.`, components: [] });
    await logEvent(interaction.guild, 'User Untrusted', `<@${interaction.user.id}> untrusted <@${targetId}> in **${vc.name}**`);
    touchActivity(vc.id).catch(() => null);
  } catch {
    await interaction.editReply({ content: 'Selection timed out.', components: [] }).catch(() => null);
  }
}

// ── Block (user select) ──

export async function handleBlock(interaction) {
  const vc = getVoiceChannel(interaction);
  if (!vc) return;
  if (!checkAccess(interaction, vc.id)) return;
  if (!checkRate(interaction)) return;

  const menu = new UserSelectMenuBuilder().setCustomId('tv_block_select').setPlaceholder('Select a user to block...');
  const row = new ActionRowBuilder().addComponents(menu);
  const reply = await interaction.reply({ content: 'Select a user to block:', components: [row], flags: ['Ephemeral'], fetchReply: true });

  try {
    const collected = await reply.awaitMessageComponent({ componentType: ComponentType.UserSelect, time: COLLECTOR_TIMEOUT });
    const targetId = collected.values[0];

    await vc.permissionOverwrites.edit(targetId, {
      ViewChannel: false,
      Connect: false,
      Speak: false,
      Stream: false,
      UseVAD: false,
      SendMessages: false,
    });

    // Disconnect the blocked user if they're in the channel
    const blockedMember = vc.members.get(targetId);
    if (blockedMember) await blockedMember.voice.disconnect('Blocked from temp channel').catch(() => null);

    await collected.update({ content: `<@${targetId}> has been blocked.`, components: [] });
    await logEvent(interaction.guild, 'User Blocked', `<@${interaction.user.id}> blocked <@${targetId}> in **${vc.name}**`);
    touchActivity(vc.id).catch(() => null);
  } catch {
    await interaction.editReply({ content: 'Selection timed out.', components: [] }).catch(() => null);
  }
}

// ── Unblock (user select) ──

export async function handleUnblock(interaction) {
  const vc = getVoiceChannel(interaction);
  if (!vc) return;
  if (!checkAccess(interaction, vc.id)) return;
  if (!checkRate(interaction)) return;

  const menu = new UserSelectMenuBuilder().setCustomId('tv_unblock_select').setPlaceholder('Select a user to unblock...');
  const row = new ActionRowBuilder().addComponents(menu);
  const reply = await interaction.reply({ content: 'Select a user to unblock:', components: [row], flags: ['Ephemeral'], fetchReply: true });

  try {
    const collected = await reply.awaitMessageComponent({ componentType: ComponentType.UserSelect, time: COLLECTOR_TIMEOUT });
    const targetId = collected.values[0];

    await vc.permissionOverwrites.delete(targetId).catch(() => null);
    await collected.update({ content: `<@${targetId}> has been unblocked.`, components: [] });
    await logEvent(interaction.guild, 'User Unblocked', `<@${interaction.user.id}> unblocked <@${targetId}> in **${vc.name}**`);
    touchActivity(vc.id).catch(() => null);
  } catch {
    await interaction.editReply({ content: 'Selection timed out.', components: [] }).catch(() => null);
  }
}

// ── Bitrate (select menu) ──

export async function handleBitrate(interaction) {
  const vc = getVoiceChannel(interaction);
  if (!vc) return;
  if (!checkAccess(interaction, vc.id)) return;
  if (!checkRate(interaction)) return;

  const options = [
    { label: '32 kbps', value: '32000' },
    { label: '48 kbps', value: '48000' },
    { label: '64 kbps', value: '64000' },
    { label: '80 kbps', value: '80000' },
    { label: '96 kbps', value: '96000' },
  ];

  // Boost tier unlocks higher bitrates
  const tier = interaction.guild.premiumTier;
  if (tier >= 1) options.push({ label: '128 kbps', value: '128000' });
  if (tier >= 2) options.push({ label: '256 kbps', value: '256000' });
  if (tier >= 3) options.push({ label: '384 kbps', value: '384000' });

  const menu = new StringSelectMenuBuilder()
    .setCustomId('tv_bitrate_select')
    .setPlaceholder('Choose audio bitrate...')
    .addOptions(options);

  const row = new ActionRowBuilder().addComponents(menu);
  const reply = await interaction.reply({ content: 'Select a bitrate:', components: [row], flags: ['Ephemeral'], fetchReply: true });

  try {
    const collected = await reply.awaitMessageComponent({ componentType: ComponentType.StringSelect, time: COLLECTOR_TIMEOUT });
    const bitrate = parseInt(collected.values[0], 10);
    await vc.setBitrate(bitrate);
    if (isOwner(vc.id, interaction.user.id)) await updatePresetField(interaction.user.id, interaction.guild.id, 'bitrate', bitrate).catch(() => null);
    await collected.update({ content: `Bitrate set to **${bitrate / 1000} kbps**.`, components: [] });
    touchActivity(vc.id).catch(() => null);
  } catch {
    await interaction.editReply({ content: 'Selection timed out.', components: [] }).catch(() => null);
  }
}

// ── Invite (user select -> DM invite) ──

export async function handleInvite(interaction) {
  const vc = getVoiceChannel(interaction);
  if (!vc) return;
  if (!checkAccess(interaction, vc.id)) return;
  if (!checkRate(interaction)) return;

  const menu = new UserSelectMenuBuilder().setCustomId('tv_invite_select').setPlaceholder('Select a user to invite...');
  const row = new ActionRowBuilder().addComponents(menu);
  const reply = await interaction.reply({ content: 'Select a user to invite:', components: [row], flags: ['Ephemeral'], fetchReply: true });

  try {
    const collected = await reply.awaitMessageComponent({ componentType: ComponentType.UserSelect, time: COLLECTOR_TIMEOUT });
    const targetId = collected.values[0];

    const invite = await vc.createInvite({ maxAge: 86400, maxUses: 1, reason: 'RB Voice invite' });
    const targetUser = await interaction.client.users.fetch(targetId).catch(() => null);

    if (targetUser) {
      await targetUser.send({
        content: `You've been invited to **${vc.name}** by **${interaction.user.displayName}**:\n${invite.url}`,
      }).catch(() => null);
    }

    await collected.update({ content: `Invite sent to <@${targetId}>.`, components: [] });
    touchActivity(vc.id).catch(() => null);
  } catch {
    await interaction.editReply({ content: 'Selection timed out.', components: [] }).catch(() => null);
  }
}

// ── Kick (select from channel members) ──

export async function handleKick(interaction) {
  const vc = getVoiceChannel(interaction);
  if (!vc) return;
  if (!checkAccess(interaction, vc.id)) return;
  if (!checkRate(interaction)) return;

  const members = vc.members.filter((m) => m.id !== interaction.user.id && !m.user.bot);
  if (members.size === 0) {
    return interaction.reply({ embeds: [errorEmbed('No other members in the channel.')], flags: ['Ephemeral'] });
  }

  const options = members.map((m) => ({ label: m.displayName, value: m.id, description: m.user.tag }));

  const menu = new StringSelectMenuBuilder()
    .setCustomId('tv_kick_select')
    .setPlaceholder('Select a user to kick...')
    .addOptions(options.slice(0, 25));

  const row = new ActionRowBuilder().addComponents(menu);
  const reply = await interaction.reply({ content: 'Select a user to kick:', components: [row], flags: ['Ephemeral'], fetchReply: true });

  try {
    const collected = await reply.awaitMessageComponent({ componentType: ComponentType.StringSelect, time: COLLECTOR_TIMEOUT });
    const targetId = collected.values[0];
    const target = vc.members.get(targetId);

    if (target) {
      await target.voice.disconnect('Kicked from temp channel').catch(() => null);
    }

    await collected.update({ content: `<@${targetId}> has been kicked.`, components: [] });
    await logEvent(interaction.guild, 'User Kicked', `<@${interaction.user.id}> kicked <@${targetId}> from **${vc.name}**`);
    touchActivity(vc.id).catch(() => null);
  } catch {
    await interaction.editReply({ content: 'Selection timed out.', components: [] }).catch(() => null);
  }
}

// ── Claim ──

export async function handleClaim(interaction) {
  const vc = getVoiceChannel(interaction);
  if (!vc) return;
  if (!checkRate(interaction)) return;

  // Claim is the opposite -- only non-owners can claim
  if (isOwner(vc.id, interaction.user.id)) {
    return interaction.reply({ embeds: [errorEmbed('You already own this channel.')], flags: ['Ephemeral'] });
  }

  const result = await claimChannel(vc.id, interaction.user.id, interaction.guild);
  if (result.success) {
    await interaction.reply({ embeds: [successEmbed('You now own this channel.')], flags: ['Ephemeral'] });
  } else {
    await interaction.reply({ embeds: [errorEmbed(result.reason)], flags: ['Ephemeral'] });
  }
}

// ── Transfer (user select) ──

export async function handleTransfer(interaction) {
  const vc = getVoiceChannel(interaction);
  if (!vc) return;
  if (!checkAccess(interaction, vc.id)) return;
  if (!checkRate(interaction)) return;

  const menu = new UserSelectMenuBuilder().setCustomId('tv_transfer_select').setPlaceholder('Select the new owner...');
  const row = new ActionRowBuilder().addComponents(menu);
  const reply = await interaction.reply({ content: 'Select a user to transfer ownership to:', components: [row], flags: ['Ephemeral'], fetchReply: true });

  try {
    const collected = await reply.awaitMessageComponent({ componentType: ComponentType.UserSelect, time: COLLECTOR_TIMEOUT });
    const targetId = collected.values[0];

    if (targetId === interaction.user.id) {
      return collected.update({ content: 'You cannot transfer to yourself.', components: [] });
    }

    const success = await transferOwnership(vc.id, targetId, interaction.guild);
    if (success) {
      await collected.update({ content: `Ownership transferred to <@${targetId}>.`, components: [] });
    } else {
      await collected.update({ content: 'Failed to transfer ownership.', components: [] });
    }
  } catch {
    await interaction.editReply({ content: 'Selection timed out.', components: [] }).catch(() => null);
  }
}

// ── Delete ──

export async function handleDelete(interaction) {
  const vc = getVoiceChannel(interaction);
  if (!vc) return;
  if (!checkAccess(interaction, vc.id)) return;
  if (!checkRate(interaction)) return;

  await interaction.reply({ embeds: [successEmbed('Channel will be deleted.')], flags: ['Ephemeral'] });

  // Small delay to let the reply send before the channel is destroyed
  setTimeout(() => {
    deleteChannelByInteraction(vc.id, interaction.guild, interaction.user.id);
  }, 500);
}
