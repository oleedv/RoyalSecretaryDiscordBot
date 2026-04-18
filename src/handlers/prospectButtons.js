import {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { rawModal, labelComponent, textInput, radioGroup } from '../utils/modalComponents.js';
import { getOpenProspectByUser, getProspectByChannel, getProspectByChannelAnyStatus, claimProspect, unclaimProspect, acceptProspect, extendProspect, closeProspect } from '../services/prospect/prospectService.js';
import { postVote, getProspectByVoteMessage, upsertVote, getVoteCounts } from '../services/prospect/prospectVoting.js';
import { buildVoteComponents, buildCloseTicketComponents } from '../services/prospect/prospectEmbeds.js';
import { getPlaytime } from '../services/playtimeService.js';
import { query } from '../database/connection.js';
import { errorEmbed, successEmbed, infoEmbed } from '../utils/embed.js';
import { requireRole } from '../utils/permissions.js';
import config from '../config.js';
import logger from '../logger.js';

const log = logger.child({ module: 'prospectButtons' });

const staffRoles = () => config.prospects.roles || [];

export async function handleApply(interaction) {
  const existing = await getOpenProspectByUser(interaction.user.id);
  if (existing) {
    return interaction.reply({ embeds: [errorEmbed('You already have an open prospect application.')], flags: ['Ephemeral'] });
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
        .setCustomId('preferred_roles')
        .setLabel('Preferred roles')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
    )
  );

  await interaction.showModal(modal);
}

export async function handleModal2Open(interaction) {
  const modal = rawModal('prospect_modal_2', 'Join Royal Battalion (2/2)', [
    labelComponent('Previous clan? (or "No")', textInput('prev_clan', 'short', { required: true })),
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

  const voiceLink = `https://discord.com/channels/${interaction.guild.id}/${voiceChannelId}`;
  await user.send({ embeds: [infoEmbed(`You've been invited to join a voice chat with a mentor! Click here to join: ${voiceLink}`)] }).catch(() => null);

  await interaction.reply({ embeds: [successEmbed(`Voice invite sent to **${prospect.alias}**.`)], flags: ['Ephemeral'] });
  log.info({ prospectId: prospect.id, invitedBy: interaction.user.id }, 'Voice invite sent to prospect');
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
    if (stats && stats.playtimeHours < 16) {
      playtimeWarning = `**${prospect.alias}** only has **${stats.playtimeHours}h** playtime (16h required). Posting vote anyway since this is a force action.`;
    }
  }

  await postVote(prospect, interaction.client);
  const embeds = [successEmbed(`Force vote posted for **${prospect.alias}**.`)];
  if (playtimeWarning) embeds.unshift(infoEmbed(playtimeWarning));
  await interaction.editReply({ embeds });
  log.info({ prospectId: prospect.id, actorId: interaction.user.id }, 'Force vote triggered');
}

export async function handleVoteYes(interaction) {
  if (await requireRole(interaction, staffRoles())) return;
  await interaction.deferUpdate();
  const prospect = await getProspectByVoteMessage(interaction.message.id);
  if (!prospect) return;

  await upsertVote(prospect.id, interaction.user.id, interaction.user.tag, 'yes');
  const counts = await getVoteCounts(prospect.id);
  const components = buildVoteComponents(counts);
  await interaction.message.edit({ components });
  log.info({ prospectId: prospect.id, voterId: interaction.user.id, vote: 'yes' }, 'Vote recorded');
}

export async function handleVoteUnsure(interaction) {
  if (await requireRole(interaction, staffRoles())) return;
  await interaction.deferUpdate();
  const prospect = await getProspectByVoteMessage(interaction.message.id);
  if (!prospect) return;

  await upsertVote(prospect.id, interaction.user.id, interaction.user.tag, 'unsure');
  const counts = await getVoteCounts(prospect.id);
  const components = buildVoteComponents(counts);
  await interaction.message.edit({ components });
  log.info({ prospectId: prospect.id, voterId: interaction.user.id, vote: 'unsure' }, 'Vote recorded');
}

export async function handleEndVote(interaction) {
  if (await requireRole(interaction, staffRoles())) return;
  await interaction.deferReply({ flags: ['Ephemeral'] });
  const prospect = await getProspectByChannel(interaction.channel.id);
  if (!prospect) return interaction.editReply({ embeds: [errorEmbed('No open prospect found for this channel.')] });

  const counts = await getVoteCounts(prospect.id);

  const MIN_VOTES = config.prospects?.minYesVotes ?? 10;
  const MIN_RATE = config.prospects?.minYesRate ?? 0.80;

  // Design: "unsure" votes are intentionally excluded from the pass/fail ratio -- only yes/no determine outcome
  const totalVotes = counts.yes + counts.no;
  const yesRate = totalVotes > 0 ? counts.yes / totalVotes : 0;
  const meetsMinimum = counts.yes >= MIN_VOTES;
  const meetsRate = yesRate >= MIN_RATE;
  const outcome = (meetsMinimum && meetsRate) ? 'accepted' : 'denied';

  if (outcome === 'denied' && (!meetsMinimum || !meetsRate)) {
    const warnings = [];
    if (!meetsMinimum) warnings.push(`${counts.yes}/${MIN_VOTES} minimum yes votes`);
    if (!meetsRate) warnings.push(`${Math.round(yesRate * 100)}% of ${Math.round(MIN_RATE * 100)}% required yes rate`);
    await interaction.channel.send({
      embeds: [infoEmbed(`Thresholds not met: ${warnings.join(', ')}. Prospect will be **denied**.`)],
    }).catch(() => null);
  }

  const reason = outcome === 'denied' ? 'The membership vote did not pass.' : undefined;

  await closeProspect(prospect, interaction.user.id, outcome, interaction.guild, reason);

  // Disable the End Vote button on the staff channel message
  const disabledRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('vote_end')
      .setLabel('Vote Ended')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
  );
  await interaction.message.edit({ components: [disabledRow] }).catch(() => null);

  const closeComponents = buildCloseTicketComponents();
  await interaction.channel.send({
    embeds: [successEmbed(`Vote ended for **${prospect.alias}** - result: ${counts.yes} yes, ${counts.no} no, ${counts.unsure} unsure - outcome: **${outcome}**.`)],
    components: closeComponents,
  }).catch(() => null);

  await interaction.editReply({ embeds: [successEmbed(`Vote ended for **${prospect.alias}** - outcome: **${outcome}**.`)] });
  log.info({ prospectId: prospect.id, outcome, counts, actorId: interaction.user.id }, 'Vote ended');
}

export async function handleVoteNo(interaction) {
  if (await requireRole(interaction, staffRoles())) return;
  const prospect = await getProspectByVoteMessage(interaction.message.id);
  if (!prospect) {
    return interaction.reply({ embeds: [errorEmbed('Could not find the associated prospect.')], flags: ['Ephemeral'] });
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
  await interaction.channel.delete().catch(() => null);
}
