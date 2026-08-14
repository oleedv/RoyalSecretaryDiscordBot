import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { findBotMessageByCustomId } from '../utils/messageSearch.js';
import { buildPanelMessage as buildTicketPanel } from '../services/ticket/ticketPanel.js';
import { buildPanelMessage as buildProspectPanel } from '../services/prospect/prospectPanel.js';
import { buildPanelMessage as buildVerifyPanel } from '../services/verify/verifyPanel.js';
import { buildPanelMessage as buildPurgedPanel } from '../services/purged/purgedPanel.js';
import { getSeedingConfig, setPanelMessageId } from '../services/seeding/seedingService.js';
import { stopStatusUpdater, startStatusUpdater } from '../services/serverStatus/serverStatusService.js';
import { refreshQuickStatus } from '../services/serverStatus/quickStatusService.js';
import { refreshLiveLayerHighlight } from '../services/layerRotationValidator/layerRotationValidatorScheduler.js';
import { successEmbed, errorEmbed } from '../utils/embed.js';
import config from '../config.js';
import logger from '../logger.js';

const log = logger.child({ module: 'cmd:refresh-panels' });

const OWNER_ID = '195412349153312768';

const STATIC_PANELS = [
  { key: 'ticket', label: 'Ticket', channelId: () => config.tickets?.panelChannelId, customId: 'ticket_create', build: buildTicketPanel },
  { key: 'prospect', label: 'Prospect', channelId: () => config.prospects?.panelChannelId, customId: 'prospect_apply', build: buildProspectPanel },
  { key: 'verify', label: 'Verify', channelId: () => config.verification?.panelChannelId, customId: 'verify_start', build: buildVerifyPanel },
  { key: 'purged', label: 'Purged', channelId: () => config.purged?.channelId, customId: 'purged_ticket_create', build: buildPurgedPanel },
];

async function refreshStaticPanel(interaction, panel) {
  const chId = panel.channelId();
  if (!chId) return `${panel.label}: skipped (no channel configured)`;

  const channel = await interaction.guild.channels.fetch(chId).catch(() => null);
  if (!channel) return `${panel.label}: skipped (channel not found)`;

  const existing = await findBotMessageByCustomId(channel, interaction.client.user.id, panel.customId);
  if (existing) await existing.delete().catch(() => {});

  await channel.send(panel.build());
  log.info(`${panel.label} panel refreshed`);
  return `${panel.label}: refreshed`;
}

async function refreshSeedingPanel(interaction) {
  const cfg = await getSeedingConfig();
  if (!cfg?.enabled || !cfg.channel_id) return 'Seeding: skipped (not configured/enabled)';

  const channel = await interaction.guild.channels.fetch(cfg.channel_id).catch(() => null);
  if (!channel) return 'Seeding: skipped (channel not found)';

  // Find existing panel by seeding_join button
  const messages = await channel.messages.fetch({ limit: 50 });
  const panel = messages.find(
    (msg) => msg.author.id === interaction.client.user.id &&
      msg.components.some((row) => row.components.some((c) => c.customId === 'seeding_join'))
  );

  if (panel) await panel.delete().catch(() => {});
  await setPanelMessageId(null);

  log.info('Seeding panel deleted -- scheduler will re-post on next tick');
  return 'Seeding: deleted (will re-post automatically within ~60s)';
}

async function refreshServerStatus(interaction) {
  const channelId = config.serverStatus?.channelId;
  if (!channelId) return 'Server Status: skipped (no channel configured)';

  const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
  if (!channel) return 'Server Status: skipped (channel not found)';

  // Delete existing bot embed messages
  const messages = await channel.messages.fetch({ limit: 20 });
  const botEmbeds = messages.filter(
    (msg) => msg.author.id === interaction.client.user.id && msg.embeds.length > 0
  );

  for (const msg of botEmbeds.values()) {
    await msg.delete().catch(() => {});
  }

  // Restart the updater to re-create fresh messages
  stopStatusUpdater();
  await startStatusUpdater(interaction.client);

  log.info({ deleted: botEmbeds.size }, 'Server status refreshed');
  return `Server Status: refreshed (${botEmbeds.size} message(s) replaced)`;
}

async function refreshLayerRotation(interaction) {
  const result = await refreshLiveLayerHighlight(interaction.client);
  if (result.ok) {
    log.info('Layer rotation embed refreshed');
    return 'Layer Rotation: refreshed';
  }
  return `Layer Rotation: skipped (${result.reason})`;
}

async function refreshQuickStatusPanel(interaction) {
  return refreshQuickStatus(interaction.client);
}

export default {
  data: new SlashCommandBuilder()
    .setName('refresh-panels')
    .setDescription('Delete and re-post bot panel messages (fixes invisible messages)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((opt) =>
      opt
        .setName('panel')
        .setDescription('Which panel to refresh (default: all)')
        .addChoices(
          { name: 'All', value: 'all' },
          { name: 'Ticket', value: 'ticket' },
          { name: 'Prospect', value: 'prospect' },
          { name: 'Verify', value: 'verify' },
          { name: 'Purged', value: 'purged' },
          { name: 'Seeding', value: 'seeding' },
          { name: 'Server Status', value: 'server-status' },
          { name: 'Quick Status', value: 'quick-status' },
          { name: 'Layer Rotation', value: 'layer-rotation' },
        )
    ),

  async execute(interaction) {
    if (interaction.user.id !== OWNER_ID) {
      return interaction.reply({ embeds: [errorEmbed('This command is restricted.')], flags: ['Ephemeral'] });
    }

    await interaction.deferReply({ flags: ['Ephemeral'] });

    const choice = interaction.options.getString('panel') || 'all';
    const results = [];

    try {
      if (choice === 'all' || STATIC_PANELS.some((p) => p.key === choice)) {
        const panels = choice === 'all' ? STATIC_PANELS : STATIC_PANELS.filter((p) => p.key === choice);
        for (const panel of panels) {
          results.push(await refreshStaticPanel(interaction, panel));
        }
      }

      if (choice === 'all' || choice === 'seeding') {
        results.push(await refreshSeedingPanel(interaction));
      }

      if (choice === 'all' || choice === 'server-status') {
        results.push(await refreshServerStatus(interaction));
      }

      if (choice === 'all' || choice === 'quick-status') {
        results.push(await refreshQuickStatusPanel(interaction));
      }

      if (choice === 'all' || choice === 'layer-rotation') {
        results.push(await refreshLayerRotation(interaction));
      }

      await interaction.editReply({ embeds: [successEmbed(results.join('\n'))] });
    } catch (err) {
      log.error({ err }, 'Panel refresh failed');
      await interaction.editReply({ embeds: [errorEmbed(`Refresh failed: ${err.message}`)] });
    }
  },
};
