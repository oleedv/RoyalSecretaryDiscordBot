import { Events } from 'discord.js';
import * as ticketButtons from '../handlers/ticketButtons.js';
import * as ticketModals from '../handlers/ticketModals.js';
import * as prospectButtons from '../handlers/prospectButtons.js';
import * as prospectModals from '../handlers/prospectModals.js';
import * as seedingButtons from '../handlers/seedingButtons.js';
import { errorEmbed } from '../utils/embed.js';
import logger from '../logger.js';

const log = logger.child({ module: 'interactions' });

const buttonHandlers = {
  ticket_create: ticketButtons.handleCreate,
  ticket_escalate_co: ticketButtons.handleEscalate,
  ticket_escalate_admin: ticketButtons.handleEscalate,
  ticket_escalate_comp: ticketButtons.handleEscalate,
  ticket_escalate_wl: ticketButtons.handleEscalate,
  ticket_close: ticketButtons.handleClose,
  ticket_reopen: ticketButtons.handleReopen,
  ticket_force_close: ticketButtons.handleForceClose,
  ticket_timeout: ticketButtons.handleTimeout,
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
      preferredRoles: getField('Preferred Roles'),
    });

    return prospectButtons.handleModal2Open(interaction);
  },
  prospect_claim: prospectButtons.handleClaim,
  prospect_unclaim: prospectButtons.handleUnclaim,
  prospect_accept: prospectButtons.handleAccept,
  prospect_deny: prospectButtons.handleDeny,
  prospect_voice_invite: prospectButtons.handleVoiceInvite,
  prospect_pause: prospectButtons.handlePause,
  prospect_extend: prospectButtons.handleExtend,
  prospect_test_vote: prospectButtons.handleTestVote,
  vote_yes: prospectButtons.handleVoteYes,
  vote_no: prospectButtons.handleVoteNo,
  vote_unsure: prospectButtons.handleVoteUnsure,
  vote_end: prospectButtons.handleEndVote,
  seeding_join: seedingButtons.handleJoin,
  seeding_leave: seedingButtons.handleLeave,
};

const modalHandlers = {
  ticket_create_modal: ticketModals.handleCreateModal,
  ticket_create_modal_quick: ticketModals.handleCreateModalQuick,
  prospect_modal_1: prospectModals.handleModal1,
  prospect_modal_2: prospectModals.handleModal2,
  prospect_deny_modal: prospectModals.handleDenyModal,
  prospect_extend_modal: prospectModals.handleExtendModal,
};

export default {
  name: Events.InteractionCreate,

  async execute(interaction) {
    if (interaction.isChatInputCommand()) {
      return handleCommand(interaction);
    }

    if (interaction.isButton()) {
      let handler = buttonHandlers[interaction.customId];
      if (!handler && (interaction.customId.startsWith('logs_prev:') || interaction.customId.startsWith('logs_next:'))) {
        handler = ticketButtons.handleLogsPagination;
      }
      if (handler) {
        try {
          await handler(interaction);
        } catch (err) {
          log.error({ err, customId: interaction.customId }, 'Button interaction failed');
          try {
            const reply = { embeds: [errorEmbed('Something went wrong.')], flags: ['Ephemeral'] };
            if (interaction.replied || interaction.deferred) {
              await interaction.followUp(reply);
            } else {
              await interaction.reply(reply);
            }
          } catch { /* interaction expired or channel gone — nothing we can do */ }
        }
      }
      return;
    }

    if (interaction.isModalSubmit()) {
      let handler = modalHandlers[interaction.customId];
      if (!handler && interaction.customId.startsWith('vote_no_reason_modal:')) {
        handler = prospectModals.handleVoteNoModal;
      }
      if (handler) {
        try {
          await handler(interaction);
        } catch (err) {
          log.error({ err, customId: interaction.customId }, 'Modal interaction failed');
          try {
            const reply = { embeds: [errorEmbed('Something went wrong.')], flags: ['Ephemeral'] };
            if (interaction.replied || interaction.deferred) {
              await interaction.followUp(reply);
            } else {
              await interaction.reply(reply);
            }
          } catch { /* interaction expired or channel gone — nothing we can do */ }
        }
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

  try {
    log.debug(
      `${interaction.user.tag} used /${interaction.commandName} in #${interaction.channel?.name}`
    );
    await command.execute(interaction);
  } catch (err) {
    log.error({ err, command: interaction.commandName }, 'Command execution failed');

    try {
      const reply = { embeds: [errorEmbed('There was an error executing this command.')], flags: ['Ephemeral'] };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply);
      } else {
        await interaction.reply(reply);
      }
    } catch { /* interaction expired or channel gone — nothing we can do */ }
  }
}
