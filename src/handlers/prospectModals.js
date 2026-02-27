import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createEmbed, errorEmbed, successEmbed } from '../utils/embed.js';
import { validateDateOfBirth, validateSquadHours } from '../utils/validation.js';
import { validateCountry } from '../utils/countries.js';
import { validateSteamInput } from '../services/steamService.js';
import { createProspect, getProspectByChannel, closeProspect, extendProspect } from '../services/prospect/prospectService.js';
import { linkSteamId } from '../services/userService.js';
import { upsertVote, getVoteCounts } from '../services/prospect/prospectVoting.js';
import { buildVoteComponents } from '../services/prospect/prospectEmbeds.js';
import { requireRole } from '../utils/permissions.js';
import config from '../config.js';
import logger from '../logger.js';

const log = logger.child({ module: 'prospectModals' });

const staffRoles = () => config.prospects.roles || [];

// In-memory store for Part 1 data between the two modals (keyed by userId)
const pendingApplications = new Map();
const pendingTimers = new Map();
const pendingCleanups = new Map();
const PENDING_TTL = 15 * 60 * 1000; // 15 minutes
const MAX_PENDING = 100;

/**
 * Store Part 1 data for a user (called from the button handler before showing modal 2).
 */
export function storePart1(userId, data) {
  // Clear previous timer if user re-submits Part 1
  const prevTimer = pendingTimers.get(userId);
  if (prevTimer) clearTimeout(prevTimer);

  // Evict oldest entry if at capacity
  if (pendingApplications.size >= MAX_PENDING && !pendingApplications.has(userId)) {
    const firstKey = pendingApplications.keys().next().value;
    pendingApplications.delete(firstKey);
    const oldTimer = pendingTimers.get(firstKey);
    if (oldTimer) { clearTimeout(oldTimer); pendingTimers.delete(firstKey); }
  }

  pendingApplications.set(userId, data);
  const timer = setTimeout(() => {
    pendingApplications.delete(userId);
    pendingTimers.delete(userId);
  }, PENDING_TTL);
  pendingTimers.set(userId, timer);
}

export async function handleModal1(interaction) {
  const alias = interaction.fields.getTextInputValue('alias').trim();
  const countryInput = interaction.fields.getTextInputValue('country').trim();
  const dateOfBirth = interaction.fields.getTextInputValue('date_of_birth').trim();
  const squadHours = interaction.fields.getTextInputValue('squad_hours').trim();
  const preferredRoles = interaction.fields.getTextInputValue('preferred_roles').trim();

  const errors = [];
  if (!alias || alias.length > 32) errors.push('**Alias**: must be 1-32 characters.');

  const countryResult = validateCountry(countryInput);
  if (!countryInput) {
    errors.push('**Country**: required.');
  } else if (!countryResult.valid) {
    errors.push('**Country**: not recognized. Please enter your country name (e.g. Germany, United States).');
  }

  const dobError = validateDateOfBirth(dateOfBirth);
  if (dobError) errors.push(dobError);

  const hoursError = validateSquadHours(squadHours);
  if (hoursError) errors.push(hoursError);

  if (!preferredRoles) errors.push('**Preferred Roles**: required.');

  if (errors.length > 0) {
    return interaction.reply({
      embeds: [errorEmbed(`Please fix the following:\n${errors.join('\n')}`)],
      flags: ['Ephemeral'],
    });
  }

  const summaryEmbed = createEmbed('Prospect')
    .setTitle('Application Part 1 — Received')
    .setDescription('Click **Continue Application** to complete part 2.')
    .addFields(
      { name: 'Alias', value: alias, inline: true },
      { name: 'Country', value: countryResult.valid ? countryResult.country : countryInput, inline: true },
      { name: 'Date of Birth', value: dateOfBirth, inline: true },
      { name: 'Hours in Squad', value: squadHours, inline: true },
      { name: 'Preferred Roles', value: preferredRoles, inline: true },
    )
    .setColor(0x57f287);

  const continueRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('prospect_modal_2_open')
      .setLabel('Continue Application')
      .setStyle(ButtonStyle.Success)
  );

  await interaction.reply({
    embeds: [summaryEmbed],
    components: [continueRow],
    flags: ['Ephemeral'],
  });

  pendingCleanups.set(interaction.user.id, () => interaction.deleteReply().catch(() => null));
  setTimeout(() => pendingCleanups.delete(interaction.user.id), PENDING_TTL);
}

export async function handleModal2(interaction) {
  await interaction.deferReply({ flags: ['Ephemeral'] });

  const prevClan = interaction.fields.getTextInputValue('prev_clan').trim();
  const whyRb = interaction.fields.getTextInputValue('why_rb').trim();
  const activeHours = interaction.fields.getTextInputValue('active_hours').trim();
  const competitive = interaction.fields.getTextInputValue('competitive').trim();
  const steamId = interaction.fields.getTextInputValue('steam_id').trim();

  const errors = [];
  if (!prevClan) errors.push('**Previous Clan**: required (can be "No").');
  if (!whyRb || whyRb.length < 10) errors.push('**Why RB**: required, minimum 10 characters.');
  if (!activeHours) errors.push('**Active Hours**: required.');
  if (!competitive) errors.push('**Competitive Interest**: required.');

  const steamValidation = validateSteamInput(steamId);
  if (!steamValidation.valid) {
    errors.push(`**Steam ID**: ${steamValidation.reason}`);
  }

  if (errors.length > 0) {
    return interaction.editReply({
      embeds: [errorEmbed(`Please fix the following:\n${errors.join('\n')}`)],
    });
  }

  const validatedSteamId = steamValidation.steamId;

  const part1 = pendingApplications.get(interaction.user.id);
  if (!part1) {
    return interaction.editReply({
      embeds: [errorEmbed('Your Part 1 data has expired. Please start over by clicking **Join RB** again.')],
    });
  }
  pendingApplications.delete(interaction.user.id);

  const formData = {
    alias: part1.alias,
    nationality: part1.country,
    dateOfBirth: part1.dateOfBirth,
    squadHours: Number(part1.squadHours),
    preferredRoles: part1.preferredRoles,
    prevClan,
    whyRb,
    activeHours,
    competitive,
    steamId: validatedSteamId,
  };

  const guild = interaction.guild ?? await interaction.client.guilds.fetch(config.guild.id);
  const result = await createProspect(interaction.user.id, guild, formData);
  if (result.error) {
    return interaction.editReply({ embeds: [errorEmbed(result.error)] });
  }

  await interaction.editReply({
    embeds: [successEmbed('Your application has been submitted! Check your DMs for confirmation.')],
  });

  linkSteamId(interaction.user.id, validatedSteamId);

  const cleanup = pendingCleanups.get(interaction.user.id);
  if (cleanup) {
    pendingCleanups.delete(interaction.user.id);
    cleanup();
  }

  log.info({ userId: interaction.user.id, channelId: result.channel.id }, 'Prospect created via modal');
}

export async function handleDenyModal(interaction) {
  if (await requireRole(interaction, staffRoles())) return;
  await interaction.deferReply({ flags: ['Ephemeral'] });
  const prospect = await getProspectByChannel(interaction.channel.id);
  if (!prospect) return interaction.editReply({ embeds: [errorEmbed('No open prospect found for this channel.')] });

  const reason = interaction.fields.getTextInputValue('deny_reason').trim();
  await closeProspect(prospect, interaction.user.id, 'denied', interaction.guild, reason);
  log.info({ prospectId: prospect.id, deniedBy: interaction.user.id, reason }, 'Prospect denied via button');
  await interaction.channel.delete().catch(() => null);
}

export async function handleExtendModal(interaction) {
  if (await requireRole(interaction, staffRoles())) return;
  await interaction.deferReply({ flags: ['Ephemeral'] });
  const prospect = await getProspectByChannel(interaction.channel.id);
  if (!prospect) return interaction.editReply({ embeds: [errorEmbed('No open prospect found for this channel.')] });

  const daysInput = interaction.fields.getTextInputValue('extend_days').trim();
  const days = parseInt(daysInput, 10);
  if (isNaN(days) || days < 1 || days > 365) {
    return interaction.editReply({ embeds: [errorEmbed('Please enter a valid number of days (1-365).')] });
  }

  await extendProspect(prospect, days, interaction.user.id, interaction.guild);
  await interaction.editReply({ embeds: [successEmbed(`Extended **${prospect.alias}**'s prospect period by **${days}** day(s).`)] });
  log.info({ prospectId: prospect.id, days, actorId: interaction.user.id }, 'Prospect extended via modal');
}

export async function handleVoteNoModal(interaction) {
  await interaction.deferUpdate();
  const prospectId = parseInt(interaction.customId.split(':')[1], 10);
  if (isNaN(prospectId)) return;

  const reason = interaction.fields.getTextInputValue('vote_no_reason').trim();
  await upsertVote(prospectId, interaction.user.id, interaction.user.tag, 'no', reason);

  const counts = await getVoteCounts(prospectId);
  const components = buildVoteComponents(counts);
  if (interaction.message) {
    await interaction.message.edit({ components });
  }
  log.info({ prospectId, voterId: interaction.user.id, vote: 'no' }, 'No vote recorded with reason');
}
