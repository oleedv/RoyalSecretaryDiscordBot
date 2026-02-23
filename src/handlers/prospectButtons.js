import {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { getOpenProspectByUser, getProspectByChannel, claimProspect, unclaimProspect, acceptProspect, togglePause, extendProspect, closeProspect } from '../services/prospect/prospectService.js';
import { postVote, getProspectByVoteMessage, upsertVote, getVoteCounts } from '../services/prospect/prospectVoting.js';
import { buildVoteComponents } from '../services/prospect/prospectEmbeds.js';
import config from '../config.js';
import logger from '../logger.js';

const log = logger.child({ module: 'prospectButtons' });

export async function handleApply(interaction) {
  const existing = await getOpenProspectByUser(interaction.user.id);
  if (existing) {
    return interaction.reply({ content: 'You already have an open prospect application.', flags: ['Ephemeral'] });
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
  const modal = new ModalBuilder()
    .setCustomId('prospect_modal_2')
    .setTitle('Join Royal Battalion (2/2)');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('prev_clan')
        .setLabel('Previous clan? (or "No")')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('why_rb')
        .setLabel('Why do you want to join RB?')
        .setStyle(TextInputStyle.Paragraph)
        .setMinLength(10)
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('active_hours')
        .setLabel('Active hours (UTC)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. 18:00 - 23:00 UTC')
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('competitive')
        .setLabel('Interested in competitive play?')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('steam_id')
        .setLabel('Steam ID (Steam64 or profile URL)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. 76561198012345678')
        .setRequired(true)
    )
  );

  await interaction.showModal(modal);
}

export async function handleClaim(interaction) {
  await interaction.deferReply({ flags: ['Ephemeral'] });
  const prospect = await getProspectByChannel(interaction.channel.id);
  if (!prospect) return interaction.editReply({ content: 'No open prospect found for this channel.' });

  const result = await claimProspect(prospect, interaction.user.id, interaction.guild);
  if (result.error) return interaction.editReply({ content: result.error });

  await interaction.editReply({ content: `You are now the mentor for **${prospect.alias}**. DM relay is active.` });
  log.info({ prospectId: prospect.id, mentorId: interaction.user.id }, 'Mentor claimed prospect');
}

export async function handleUnclaim(interaction) {
  await interaction.deferReply({ flags: ['Ephemeral'] });
  const prospect = await getProspectByChannel(interaction.channel.id);
  if (!prospect) return interaction.editReply({ content: 'No open prospect found for this channel.' });

  const result = await unclaimProspect(prospect, interaction.user.id, interaction.guild);
  if (result.error) return interaction.editReply({ content: result.error });

  await interaction.editReply({ content: `Mentor has been unclaimed from **${prospect.alias}**.` });
  log.info({ prospectId: prospect.id, actorId: interaction.user.id }, 'Mentor unclaimed prospect');
}

export async function handleAccept(interaction) {
  await interaction.deferReply({ flags: ['Ephemeral'] });
  const prospect = await getProspectByChannel(interaction.channel.id);
  if (!prospect) return interaction.editReply({ content: 'No open prospect found for this channel.' });
  if (prospect.forum_thread_id) return interaction.editReply({ content: 'This prospect has already been accepted.' });

  await acceptProspect(prospect, interaction.user.id, interaction.guild);
  await interaction.editReply({ content: `**${prospect.alias}** has been accepted. Forum post created and prospect period started.` });
  log.info({ prospectId: prospect.id, acceptedBy: interaction.user.id }, 'Prospect accepted via button');
}

export async function handleDeny(interaction) {
  const prospect = await getProspectByChannel(interaction.channel.id);
  if (!prospect) return interaction.reply({ content: 'No open prospect found for this channel.', flags: ['Ephemeral'] });

  const modal = new ModalBuilder()
    .setCustomId('prospect_deny_modal')
    .setTitle('Deny Prospect');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('deny_reason')
        .setLabel('Reason for denial')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Provide a reason for denying this prospect...')
        .setMinLength(5)
        .setRequired(true)
    )
  );

  await interaction.showModal(modal);
}

export async function handleVoiceInvite(interaction) {
  const prospect = await getProspectByChannel(interaction.channel.id);
  if (!prospect) return interaction.reply({ content: 'No open prospect found for this channel.', flags: ['Ephemeral'] });

  const { voiceChannelId } = config.prospects;
  if (!voiceChannelId) return interaction.reply({ content: 'No voice channel configured in settings.js (`prospects.voiceChannelId`).', flags: ['Ephemeral'] });

  const user = await interaction.client.users.fetch(prospect.user_id).catch(() => null);
  if (!user) return interaction.reply({ content: 'Could not find the prospect user.', flags: ['Ephemeral'] });

  const voiceLink = `https://discord.com/channels/${interaction.guild.id}/${voiceChannelId}`;
  await user.send(
    `**[Prospect]** You've been invited to join a voice chat with a mentor! Click here to join: ${voiceLink}`
  ).catch(() => null);

  await interaction.reply({ content: `Voice invite sent to **${prospect.alias}**.`, flags: ['Ephemeral'] });
  log.info({ prospectId: prospect.id, invitedBy: interaction.user.id }, 'Voice invite sent to prospect');
}

export async function handlePause(interaction) {
  await interaction.deferReply({ flags: ['Ephemeral'] });
  const prospect = await getProspectByChannel(interaction.channel.id);
  if (!prospect) return interaction.editReply({ content: 'No open prospect found for this channel.' });

  const result = await togglePause(prospect, interaction.user.id, interaction.guild);
  const state = result.paused ? 'paused' : 'resumed';
  await interaction.editReply({ content: `Prospect **${prospect.alias}** has been **${state}**.` });
  log.info({ prospectId: prospect.id, state, actorId: interaction.user.id }, 'Prospect pause toggled');
}

export async function handleExtend(interaction) {
  const prospect = await getProspectByChannel(interaction.channel.id);
  if (!prospect) return interaction.reply({ content: 'No open prospect found for this channel.', flags: ['Ephemeral'] });

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
  await interaction.deferReply({ flags: ['Ephemeral'] });
  const prospect = await getProspectByChannel(interaction.channel.id);
  if (!prospect) return interaction.editReply({ content: 'No open prospect found for this channel.' });
  if (!prospect.forum_thread_id) return interaction.editReply({ content: 'This prospect has not been accepted yet.' });
  if (prospect.vote_posted_at) return interaction.editReply({ content: 'A vote has already been posted for this prospect.' });

  await postVote(prospect, interaction.client);
  await interaction.editReply({ content: `Force vote posted for **${prospect.alias}**.` });
  log.info({ prospectId: prospect.id, actorId: interaction.user.id }, 'Force vote triggered');
}

export async function handleVoteYes(interaction) {
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
  await interaction.deferReply({ flags: ['Ephemeral'] });
  const prospect = await getProspectByChannel(interaction.channel.id);
  if (!prospect) return interaction.editReply({ content: 'No open prospect found for this channel.' });

  const counts = await getVoteCounts(prospect.id);

  const outcome = counts.yes > counts.no ? 'accepted' : 'denied';
  const reason = outcome === 'denied' ? `Vote result: ${counts.yes} yes, ${counts.no} no, ${counts.unsure} unsure` : undefined;

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

  await interaction.editReply({ content: `Vote ended for **${prospect.alias}** — outcome: **${outcome}**.` });
  log.info({ prospectId: prospect.id, outcome, counts, actorId: interaction.user.id }, 'Vote ended');
}

export async function handleVoteNo(interaction) {
  const prospect = await getProspectByVoteMessage(interaction.message.id);
  if (!prospect) {
    return interaction.reply({ content: 'Could not find the associated prospect.', flags: ['Ephemeral'] });
  }

  const modal = new ModalBuilder()
    .setCustomId(`vote_no_reason_modal:${prospect.id}`)
    .setTitle('Vote No — Reason');

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
