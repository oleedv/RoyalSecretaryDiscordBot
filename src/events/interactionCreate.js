import { Events } from 'discord.js';
import * as ticketButtons from '../handlers/ticketButtons.js';
import * as ticketModals from '../handlers/ticketModals.js';
import * as prospectButtons from '../handlers/prospectButtons.js';
import * as prospectModals from '../handlers/prospectModals.js';
import * as seedingButtons from '../handlers/seedingButtons.js';
import * as seedTrackerButtons from '../handlers/seedTrackerButtons.js';
import * as verifyButtons from '../handlers/verifyButtons.js';
import * as activityButtons from '../handlers/activityButtons.js';
import * as prospectAiButtons from '../handlers/prospectAiButtons.js';
import * as tempvoiceButtons from '../handlers/tempvoiceButtons.js';
import * as tempvoiceModals from '../handlers/tempvoiceModals.js';
import * as clanReportButtons from '../handlers/clanReportButtons.js';
import * as clanReportSelects from '../handlers/clanReportSelects.js';
import * as giveawayButtons from '../handlers/giveawayButtons.js';
import { errorEmbed } from '../utils/embed.js';
import { reportError } from '../services/admin/errorAlertService.js';
import { logDmInteraction } from '../services/admin/dmLogService.js';
import logger from '../logger.js';

const log = logger.child({ module: 'interactions' });

async function safeReply(interaction, payload) {
  try {
    if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
    else await interaction.reply(payload);
  } catch (err) {
    log.warn({
      err,
      interactionId: interaction.id,
      customId: interaction.customId,
      userId: interaction.user?.id,
      code: err?.code,
    }, 'safeReply failed');
  }
}

function describeInteractionType(interaction) {
  if (interaction.isChatInputCommand()) return 'command';
  if (interaction.isButton()) return 'button';
  if (interaction.isModalSubmit()) return 'modal';
  if (interaction.isAnySelectMenu?.()) return 'select';
  if (interaction.isAutocomplete?.()) return 'autocomplete';
  if (interaction.isContextMenuCommand?.()) return 'context_menu';
  return 'other';
}

// Rate limiting: per-user cooldown for button/modal interactions
const cooldowns = new Map();
const COOLDOWN_MS = 2000;

// Clean up stale cooldown entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of cooldowns) {
    if (now - ts > COOLDOWN_MS) cooldowns.delete(id);
  }
}, 5 * 60 * 1000).unref();

const buttonHandlers = {
  ticket_create: ticketButtons.handleCreate,
  purged_ticket_create: ticketButtons.handlePurgedCreate,
  ticket_escalate_normal: ticketButtons.handleEscalate,
  ticket_escalate_co: ticketButtons.handleEscalate,
  ticket_escalate_admin: ticketButtons.handleEscalate,
  ticket_escalate_comp: ticketButtons.handleEscalate,
  ticket_escalate_wl: ticketButtons.handleEscalate,
  ticket_close: ticketButtons.handleClose,
  ticket_reopen: ticketButtons.handleReopen,
  ticket_force_close: ticketButtons.handleForceClose,
  ticket_timeout: ticketButtons.handleTimeout,
  ticket_anonymous: ticketButtons.handleAnonymousToggle,
  ticket_donate: ticketButtons.handleDonate,
  prospect_apply: prospectButtons.handleApply,
  prospect_modal_2_open: (interaction) => {
    // Extract Part 1 data from the embed before showing modal 2
    const embed = interaction.message.embeds[0];
    if (!embed) {
      return interaction.reply({ embeds: [errorEmbed('Could not read application data. Please start over.')], flags: ['Ephemeral'] });
    }

    const getField = (name) => embed.fields?.find((f) => f.name === name)?.value || '';
    prospectModals.storePart1(interaction.user.id, {
      alias: getField('Alias'),
      country: getField('Country'),
      dateOfBirth: getField('Date of Birth'),
      squadHours: getField('Hours in Squad'),
      prevClan: getField('Previous Clan'),
    });

    return prospectButtons.handleModal2Open(interaction);
  },
  prospect_claim: prospectButtons.handleClaim,
  prospect_unclaim: prospectButtons.handleUnclaim,
  prospect_accept: prospectButtons.handleAccept,
  prospect_deny: prospectButtons.handleDeny,
  prospect_voice_invite: prospectButtons.handleVoiceInvite,
  prospect_extend: prospectButtons.handleExtend,
  prospect_test_vote: prospectButtons.handleTestVote,
  vote_yes: prospectButtons.handleVoteYes,
  vote_no: prospectButtons.handleVoteNo,
  vote_unsure: prospectButtons.handleVoteUnsure,
  vote_end: prospectButtons.handleEndVote,
  prospect_close_ticket: prospectButtons.handleCloseTicket,
  seeding_join: seedingButtons.handleJoin,
  seeding_leave: seedingButtons.handleLeave,
  seed_progression: seedTrackerButtons.handleSeedProgression,
  verify_start: verifyButtons.handleStart,
  tv_name: tempvoiceButtons.handleName,
  tv_limit: tempvoiceButtons.handleLimit,
  tv_privacy: tempvoiceButtons.handlePrivacy,
  tv_dnd: tempvoiceButtons.handleDnd,
  tv_region: tempvoiceButtons.handleRegion,
  tv_trust: tempvoiceButtons.handleTrust,
  tv_untrust: tempvoiceButtons.handleUntrust,
  tv_block: tempvoiceButtons.handleBlock,
  tv_unblock: tempvoiceButtons.handleUnblock,
  tv_bitrate: tempvoiceButtons.handleBitrate,
  tv_invite: tempvoiceButtons.handleInvite,
  tv_kick: tempvoiceButtons.handleKick,
  tv_claim: tempvoiceButtons.handleClaim,
  tv_transfer: tempvoiceButtons.handleTransfer,
  tv_delete: tempvoiceButtons.handleDelete,
};

const modalHandlers = {
  ticket_create_modal: ticketModals.handleCreateModal,
  ticket_create_modal_quick: ticketModals.handleCreateModalQuick,
  purged_ticket_modal: ticketModals.handlePurgedModal,
  purged_ticket_modal_quick: ticketModals.handlePurgedModalQuick,
  prospect_modal_1: prospectModals.handleModal1,
  prospect_modal_2: prospectModals.handleModal2,
  prospect_deny_modal: prospectModals.handleDenyModal,
  prospect_extend_modal: prospectModals.handleExtendModal,
  tv_name_modal: tempvoiceModals.handleNameModal,
  tv_limit_modal: tempvoiceModals.handleLimitModal,
};

export default {
  name: Events.InteractionCreate,

  async execute(interaction) {
    log.info({
      interactionId: interaction.id,
      type: describeInteractionType(interaction),
      customId: interaction.customId ?? null,
      commandName: interaction.commandName ?? null,
      userId: interaction.user?.id,
      userTag: interaction.user?.tag,
      channelId: interaction.channel?.id,
      guildId: interaction.guildId,
    }, 'Interaction received');

    if (!interaction.guild) {
      if (interaction.isButton()) logDmInteraction(interaction, 'button').catch((err) => log.warn({ err }, 'logDmInteraction button failed'));
      else if (interaction.isModalSubmit()) logDmInteraction(interaction, 'modal').catch((err) => log.warn({ err }, 'logDmInteraction modal failed'));
      else if (interaction.isAnySelectMenu?.()) logDmInteraction(interaction, 'select').catch((err) => log.warn({ err }, 'logDmInteraction select failed'));
    }

    if (interaction.isChatInputCommand()) {
      return handleCommand(interaction);
    }

    if (interaction.isButton()) {
      const skipCooldown = interaction.customId.startsWith('verify_answer_');
      if (!skipCooldown) {
        const now = Date.now();
        const last = cooldowns.get(interaction.user.id) || 0;
        if (now - last < COOLDOWN_MS) {
          log.info({
            interactionId: interaction.id,
            userId: interaction.user.id,
            userTag: interaction.user.tag,
            customId: interaction.customId,
            channelId: interaction.channel?.id,
            sinceLastMs: now - last,
          }, 'Button rate-limited by cooldown');
          return interaction.reply({ content: 'Please wait before clicking again.', flags: ['Ephemeral'] }).catch((err) => {
            log.warn({ err, interactionId: interaction.id, customId: interaction.customId }, 'Cooldown reply failed');
          });
        }
        cooldowns.set(interaction.user.id, now);
      }

      let handler = buttonHandlers[interaction.customId];
      if (!handler && (interaction.customId.startsWith('logs_prev:') || interaction.customId.startsWith('logs_next:'))) {
        handler = ticketButtons.handleLogsPagination;
      }
      if (!handler && (interaction.customId.startsWith('sugg_prev:') || interaction.customId.startsWith('sugg_next:'))) {
        handler = ticketButtons.handleSuggestionPagination;
      }
      if (!handler && interaction.customId.startsWith('verify_answer_')) {
        handler = verifyButtons.handleAnswer;
      }
      if (!handler && interaction.customId.startsWith('activity_tab:')) {
        handler = activityButtons.handleTabSwitch;
      }
      if (!handler && interaction.customId.startsWith('prospect_ai_tab:')) {
        handler = prospectAiButtons.handleTabSwitch;
      }
      if (!handler && interaction.customId.startsWith('cr_window:')) {
        handler = clanReportButtons.handleWindowSwitch;
      }
      if (!handler && interaction.customId.startsWith('cr_panel:')) {
        handler = clanReportButtons.handleGenerate;
      }
      if (!handler && interaction.customId.startsWith('giveaway_enter:')) {
        handler = giveawayButtons.handleEnter;
      }
      if (!handler && interaction.customId.startsWith('giveaway_vote:')) {
        handler = giveawayButtons.handleVote;
      }
      if (handler) {
        log.info({ userId: interaction.user.id, userTag: interaction.user.tag, customId: interaction.customId, channelId: interaction.channel?.id }, 'Button pressed');
        try {
          await handler(interaction);
        } catch (err) {
          reportError(err, {
            source: `interactionCreate:button:${interaction.customId}`,
            userId: interaction.user?.id,
            userTag: interaction.user?.tag,
            guildId: interaction.guildId,
            channelId: interaction.channel?.id,
            customId: interaction.customId,
          }).catch((reportErr) => log.error({ err: reportErr, originalErr: err, customId: interaction.customId }, 'reportError failed for button'));
          await safeReply(interaction, { embeds: [errorEmbed('Something went wrong.')], flags: ['Ephemeral'] });
        }
      } else {
        log.warn({
          interactionId: interaction.id,
          userId: interaction.user.id,
          userTag: interaction.user.tag,
          customId: interaction.customId,
          channelId: interaction.channel?.id,
          messageId: interaction.message?.id,
        }, 'Unmatched button customId');
      }
      return;
    }

    if (interaction.isAnySelectMenu?.()) {
      let handler = null;
      if (interaction.customId.startsWith('cr_clan_select')) {
        handler = clanReportSelects.handleClanSelect;
      } else if (interaction.customId.startsWith('cr_server_select')) {
        handler = clanReportSelects.handleServerSelect;
      }
      if (handler) {
        log.info({ userId: interaction.user.id, userTag: interaction.user.tag, customId: interaction.customId, channelId: interaction.channel?.id }, 'Select menu used');
        try {
          await handler(interaction);
        } catch (err) {
          reportError(err, {
            source: `interactionCreate:select:${interaction.customId}`,
            userId: interaction.user?.id,
            userTag: interaction.user?.tag,
            guildId: interaction.guildId,
            channelId: interaction.channel?.id,
            customId: interaction.customId,
          }).catch((reportErr) => log.error({ err: reportErr, originalErr: err, customId: interaction.customId }, 'reportError failed for select'));
          await safeReply(interaction, { embeds: [errorEmbed('Something went wrong.')], flags: ['Ephemeral'] });
        }
      } else {
        log.warn({
          interactionId: interaction.id,
          userId: interaction.user.id,
          userTag: interaction.user.tag,
          customId: interaction.customId,
          channelId: interaction.channel?.id,
        }, 'Unmatched select menu customId');
      }
      return;
    }

    if (interaction.isModalSubmit()) {
      let handler = modalHandlers[interaction.customId];
      if (!handler && interaction.customId.startsWith('vote_no_reason_modal:')) {
        handler = prospectModals.handleVoteNoModal;
      }
      if (handler) {
        log.info({ userId: interaction.user.id, userTag: interaction.user.tag, customId: interaction.customId, channelId: interaction.channel?.id }, 'Modal submitted');
        try {
          await handler(interaction);
        } catch (err) {
          reportError(err, {
            source: `interactionCreate:modal:${interaction.customId}`,
            userId: interaction.user?.id,
            userTag: interaction.user?.tag,
            guildId: interaction.guildId,
            channelId: interaction.channel?.id,
            customId: interaction.customId,
          }).catch((reportErr) => log.error({ err: reportErr, originalErr: err, customId: interaction.customId }, 'reportError failed for modal'));
          await safeReply(interaction, { embeds: [errorEmbed('Something went wrong.')], flags: ['Ephemeral'] });
        }
      } else {
        log.warn({
          interactionId: interaction.id,
          userId: interaction.user.id,
          userTag: interaction.user.tag,
          customId: interaction.customId,
          channelId: interaction.channel?.id,
        }, 'Unmatched modal customId');
      }
    }
  },
};

async function handleCommand(interaction) {
  const command = interaction.client.commands.get(interaction.commandName);

  if (!command) {
    log.warn(`Unknown command: ${interaction.commandName}`);
    return;
  }

  // Runtime enforcement of command-level permissions
  const requiredPerms = command.data.default_member_permissions;
  if (requiredPerms && !interaction.memberPermissions?.has(BigInt(requiredPerms))) {
    return interaction.reply({ embeds: [errorEmbed('You do not have permission to use this command.')], flags: ['Ephemeral'] });
  }

  try {
    log.debug(
      `${interaction.user.tag} used /${interaction.commandName} in #${interaction.channel?.name}`
    );
    await command.execute(interaction);
  } catch (err) {
    reportError(err, {
      source: `interactionCreate:command:${interaction.commandName}`,
      userId: interaction.user?.id,
      userTag: interaction.user?.tag,
      guildId: interaction.guildId,
      channelId: interaction.channel?.id,
    }).catch((reportErr) => log.error({ err: reportErr, originalErr: err, commandName: interaction.commandName }, 'reportError failed for command'));

    await safeReply(interaction, { embeds: [errorEmbed('There was an error executing this command.')], flags: ['Ephemeral'] });
  }
}
