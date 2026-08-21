import {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from 'discord.js';
import { rawModal, labelComponent, textInput, radioGroup } from '../utils/modalComponents.js';
import { getOpenProspectByUser, getProspectByChannel, getProspectByChannelAnyStatus, claimProspect, unclaimProspect, acceptProspect, extendProspect, closeProspect } from '../services/prospect/prospectService.js';
import { applyCooldownMessage, getActiveCooldown, getProspectConfig } from '../services/prospect/prospectConfig.js';
import { postVote, getProspectByVoteMessage, upsertVote, getVoteCounts, finalizeVote } from '../services/prospect/prospectVoting.js';
import { buildVoteComponents } from '../services/prospect/prospectEmbeds.js';
import { getPlaytime } from '../services/playtimeService.js';
import { query } from '../database/connection.js';
import { errorEmbed, successEmbed, infoEmbed } from '../utils/embed.js';
import { requireRole } from '../utils/permissions.js';
import { logProspectVote } from '../services/admin/dmLogService.js';
import { flushThenDelete } from '../services/channelTranscript/channelTranscript.js';
import config from '../config.js';
import logger from '../logger.js';

const log = logger.child({ module: 'prospectButtons' });

const staffRoles = () => config.prospects.roles || [];
const voterRoles = () => {
  const staff = config.prospects.roles || [];
  const member = config.prospects.memberRoleId;
  return member ? [...staff, member] : staff;
};

export async function handleApply(interaction) {
  const existing = await getOpenProspectByUser(interaction.user.id);
  if (existing) {
    return interaction.reply({ embeds: [errorEmbed('You already have an open prospect application.')], flags: ['Ephemeral'] });
  }

  const cooldown = await getActiveCooldown(interaction.user.id);
  if (cooldown) {
    return interaction.reply({ embeds: [errorEmbed(applyCooldownMessage(cooldown.expires_at))], flags: ['Ephemeral'] });
  }

  const modal = new ModalBuilder()
    .setCustomId('prospect_modal_1')
    .setTitle('Join Royal Battalion (1/2)');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('alias')
        .setLabel('Alias / In-game name')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(32)
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('country')
        .setLabel('Country')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('date_of_birth')
        .setLabel('Date of birth (DD-MM-YYYY)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('25-12-2000')
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('squad_hours')
        .setLabel('Hours in Squad')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('prev_clan')
        .setLabel('Previous clan? (or "No")')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(200)
        .setRequired(true)
    )
  );

  await interaction.showModal(modal);
}

export async function handleModal2Open(interaction) {
  const modal = rawModal('prospect_modal_2', 'Join Royal Battalion (2/2)', [
    labelComponent('Tell us a little about yourself', textInput('about_yourself', 'paragraph', { minLength: 10, required: true })),
    labelComponent('Why do you want to join RB?', textInput('why_rb', 'paragraph', { minLength: 10, required: true })),
    labelComponent('Active hours (UTC)', textInput('active_hours', 'short', { placeholder: 'e.g. 18:00 - 23:00 UTC', required: true })),
    labelComponent('Interested in competitive play?', radioGroup('competitive', [
      { label: 'Yes', value: 'Yes' },
      { label: 'No', value: 'No' },
      { label: 'Unsure', value: 'Unsure' },
    ])),
    labelComponent('Steam ID (Steam64 or profile URL)', textInput('steam_id', 'short', { placeholder: 'e.g. 76561198012345678', required: true })),
  ]);

  await interaction.showModal(modal);
}

export async function handleClaim(interaction) {
  if (await requireRole(interaction, staffRoles())) return;
  await interaction.deferReply({ flags: ['Ephemeral'] });
  const prospect = await getProspectByChannel(interaction.channel.id);
  if (!prospect) return interaction.editReply({ embeds: [errorEmbed('No open prospect found for this channel.')] });

  const result = await claimProspect(prospect, interaction.user.id, interaction.guild);
  if (result.error) return interaction.editReply({ embeds: [errorEmbed(result.error)] });

  await interaction.editReply({ embeds: [successEmbed(`You are now the mentor for **${prospect.alias}**. DM relay is active.`)] });
  log.info({ prospectId: prospect.id, mentorId: interaction.user.id }, 'Mentor claimed prospect');
}

export async function handleUnclaim(interaction) {
  if (await requireRole(interaction, staffRoles())) return;
  await interaction.deferReply({ flags: ['Ephemeral'] });
  const prospect = await getProspectByChannel(interaction.channel.id);
  if (!prospect) return interaction.editReply({ embeds: [errorEmbed('No open prospect found for this channel.')] });

  const result = await unclaimProspect(prospect, interaction.user.id, interaction.guild);
  if (result.error) return interaction.editReply({ embeds: [errorEmbed(result.error)] });

  await interaction.editReply({ embeds: [successEmbed(`Mentor has been unclaimed from **${prospect.alias}**.`)] });
  log.info({ prospectId: prospect.id, actorId: interaction.user.id }, 'Mentor unclaimed prospect');
}

export async function handleAccept(interaction) {
  if (await requireRole(interaction, staffRoles())) return;
  await interaction.deferReply({ flags: ['Ephemeral'] });
  const prospect = await getProspectByChannel(interaction.channel.id);
  if (!prospect) return interaction.editReply({ embeds: [errorEmbed('No open prospect found for this channel.')] });
  if (prospect.forum_thread_id) return interaction.editReply({ embeds: [errorEmbed('This prospect has already been accepted.')] });

  await acceptProspect(prospect, interaction.user.id, interaction.guild);
  await interaction.editReply({ embeds: [successEmbed(`**${prospect.alias}** has been accepted. Forum post created and prospect period started.`)] });
  log.info({ prospectId: prospect.id, acceptedBy: interaction.user.id }, 'Prospect accepted via button');
}

export async function handleDeny(interaction) {
  if (await requireRole(interaction, staffRoles())) return;
  const prospect = await getProspectByChannel(interaction.channel.id);
  if (!prospect) return interaction.reply({ embeds: [errorEmbed('No open prospect found for this channel.')], flags: ['Ephemeral'] });

  const modal = new ModalBuilder()
    .setCustomId('prospect_deny_modal')
    .setTitle('Deny Prospect');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('deny_reason')
        .setLabel('Reason (will be sent to the prospect)')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Sent to the prospect via DM. Give a clear reason for denying this application...')
        .setMinLength(5)
        .setRequired(true)
    )
  );

  await interaction.showModal(modal);
}

export async function handleVoiceInvite(interaction) {
  if (await requireRole(interaction, staffRoles())) return;
  const prospect = await getProspectByChannel(interaction.channel.id);
  if (!prospect) return interaction.reply({ embeds: [errorEmbed('No open prospect found for this channel.')], flags: ['Ephemeral'] });

  const { voiceChannelId } = config.prospects;
  if (!voiceChannelId) return interaction.reply({ embeds: [errorEmbed('No voice channel configured in settings.js (`prospects.voiceChannelId`).')], flags: ['Ephemeral'] });

  const user = await interaction.client.users.fetch(prospect.user_id).catch(() => null);
  if (!user) return interaction.reply({ embeds: [errorEmbed('Could not find the prospect user.')], flags: ['Ephemeral'] });

  const voiceChannel = await interaction.guild.channels.fetch(voiceChannelId).catch(() => null);
  if (!voiceChannel) return interaction.reply({ embeds: [errorEmbed(`Configured voice channel (${voiceChannelId}) not found.`)], flags: ['Ephemeral'] });

  try {
    await voiceChannel.permissionOverwrites.edit(prospect.user_id, {
      ViewChannel: true,
      Connect: true,
      Speak: true,
    }, { reason: `Prospect voice invite by ${interaction.user.tag}` });
  } catch (err) {
    log.error({ err, prospectId: prospect.id, voiceChannelId }, 'Failed to grant voice channel access to prospect');
    return interaction.reply({ embeds: [errorEmbed(`Failed to grant voice access: ${err.message}`)], flags: ['Ephemeral'] });
  }

  const voiceLink = `https://discord.com/channels/${interaction.guild.id}/${voiceChannelId}`;
  await user.send({ embeds: [infoEmbed(`You've been invited to join a voice chat with a mentor! Click here to join: ${voiceLink}`)] }).catch(() => null);

  await interaction.reply({ embeds: [successEmbed(`Voice invite sent to **${prospect.alias}** (access granted to <#${voiceChannelId}>).`)] });
  log.info({ prospectId: prospect.id, invitedBy: interaction.user.id, voiceChannelId }, 'Voice invite sent to prospect');
}

export async function handleExtend(interaction) {
  if (await requireRole(interaction, staffRoles())) return;
  const prospect = await getProspectByChannel(interaction.channel.id);
  if (!prospect) return interaction.reply({ embeds: [errorEmbed('No open prospect found for this channel.')], flags: ['Ephemeral'] });

  const modal = new ModalBuilder()
    .setCustomId('prospect_extend_modal')
    .setTitle('Extend Prospect Period');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('extend_days')
        .setLabel('Days to add')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. 5')
        .setMinLength(1)
        .setMaxLength(3)
        .setRequired(true)
    )
  );

  await interaction.showModal(modal);
}

export async function handleTestVote(interaction) {
  if (await requireRole(interaction, staffRoles())) return;
  await interaction.deferReply({ flags: ['Ephemeral'] });
  const prospect = await getProspectByChannel(interaction.channel.id);
  if (!prospect) return interaction.editReply({ embeds: [errorEmbed('No open prospect found for this channel.')] });
  if (!prospect.forum_thread_id) return interaction.editReply({ embeds: [errorEmbed('This prospect has not been accepted yet.')] });
  if (prospect.vote_posted_at) return interaction.editReply({ embeds: [errorEmbed('A vote has already been posted for this prospect.')] });

  let playtimeWarning = null;
  if (prospect.steam_id && prospect.steam_id.toUpperCase() !== 'Q') {
    const stats = await getPlaytime(prospect.steam_id, prospect.created_at).catch(() => null);
    const live = await getProspectConfig();
    const acceptHours = live.voteAcceptHours;
    if (stats && stats.playtimeHours < acceptHours) {
      playtimeWarning = `**${prospect.alias}** only has **${stats.playtimeHours}h** playtime (${acceptHours}h required to be accepted). Posting vote anyway since this is a force action.`;
    }
  }

  await postVote(prospect, interaction.client);
  const embeds = [successEmbed(`Force vote posted for **${prospect.alias}**.`)];
  if (playtimeWarning) embeds.unshift(infoEmbed(playtimeWarning));
  await interaction.editReply({ embeds });
  log.info({ prospectId: prospect.id, actorId: interaction.user.id }, 'Force vote triggered');
}

export async function handleVoteYes(interaction) {
  if (await requireRole(interaction, voterRoles())) return;
  const prospect = await getProspectByVoteMessage(interaction.message.id);
  if (!prospect) {
    return interaction.reply({ embeds: [errorEmbed('Could not find the associated prospect.')], flags: ['Ephemeral'] });
  }
  if (prospect.user_id === interaction.user.id) {
    return interaction.reply({ embeds: [errorEmbed('You cannot vote on your own application.')], flags: ['Ephemeral'] });
  }
  await interaction.deferUpdate();

  await upsertVote(prospect.id, interaction.user.id, interaction.user.tag, 'yes');
  const counts = await getVoteCounts(prospect.id);
  const components = buildVoteComponents(counts);
  await interaction.message.edit({ components });
  logProspectVote({ voter: interaction.user, prospect, vote: 'yes' }).catch(() => null);
  log.info({ prospectId: prospect.id, voterId: interaction.user.id, vote: 'yes' }, 'Vote recorded');
}

export async function handleVoteUnsure(interaction) {
  if (await requireRole(interaction, voterRoles())) return;
  const prospect = await getProspectByVoteMessage(interaction.message.id);
  if (!prospect) {
    return interaction.reply({ embeds: [errorEmbed('Could not find the associated prospect.')], flags: ['Ephemeral'] });
  }
  if (prospect.user_id === interaction.user.id) {
    return interaction.reply({ embeds: [errorEmbed('You cannot vote on your own application.')], flags: ['Ephemeral'] });
  }
  await interaction.deferUpdate();

  await upsertVote(prospect.id, interaction.user.id, interaction.user.tag, 'unsure');
  const counts = await getVoteCounts(prospect.id);
  const components = buildVoteComponents(counts);
  await interaction.message.edit({ components });
  logProspectVote({ voter: interaction.user, prospect, vote: 'unsure' }).catch(() => null);
  log.info({ prospectId: prospect.id, voterId: interaction.user.id, vote: 'unsure' }, 'Vote recorded');
}

export async function handleEndVote(interaction) {
  if (await requireRole(interaction, staffRoles())) return;
  await interaction.deferReply({ flags: ['Ephemeral'] });
  const prospect = await getProspectByChannel(interaction.channel.id);
  if (!prospect) return interaction.editReply({ embeds: [errorEmbed('No open prospect found for this channel.')] });

  const { outcome } = await finalizeVote(prospect, interaction.user.id, interaction.client, interaction.guild);

  await interaction.editReply({ embeds: [successEmbed(`Vote ended for **${prospect.alias}** - outcome: **${outcome}**.`)] });
}

export async function handleVoteNo(interaction) {
  if (await requireRole(interaction, voterRoles())) return;
  const prospect = await getProspectByVoteMessage(interaction.message.id);
  if (!prospect) {
    return interaction.reply({ embeds: [errorEmbed('Could not find the associated prospect.')], flags: ['Ephemeral'] });
  }
  if (prospect.user_id === interaction.user.id) {
    return interaction.reply({ embeds: [errorEmbed('You cannot vote on your own application.')], flags: ['Ephemeral'] });
  }

  const modal = new ModalBuilder()
    .setCustomId(`vote_no_reason_modal:${prospect.id}`)
    .setTitle('Vote No - Reason');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('vote_no_reason')
        .setLabel('Why are you voting no?')
        .setStyle(TextInputStyle.Paragraph)
        .setMinLength(5)
        .setRequired(true)
    )
  );

  await interaction.showModal(modal);
}

export async function handleCloseTicket(interaction) {
  if (await requireRole(interaction, staffRoles())) return;
  await interaction.deferReply({ flags: ['Ephemeral'] });

  const prospect = await getProspectByChannelAnyStatus(interaction.channel.id);
  if (!prospect) return interaction.editReply({ embeds: [errorEmbed('No prospect found for this channel.')] });

  await query(
    'INSERT INTO prospect_events (prospect_id, event_type, actor_id, detail) VALUES (?, ?, ?, ?)',
    [prospect.id, 'closed', interaction.user.id, 'Ticket closed by staff']
  );

  log.info({ prospectId: prospect.id, closedBy: interaction.user.id }, 'Prospect ticket closed');
  await flushThenDelete(interaction.channel);
}
