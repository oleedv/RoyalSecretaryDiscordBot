// Button handlers for /clanreport.
//
// customId formats:
//   cr_window:<clanId>:<serverId>:<window>             re-render picker with new window
//   cr_panel:<panel>:<clanId>:<serverId>:<window>      generate .txt, replace message

import { buildPickerView } from '../services/clanReports/pickerEmbed.js';
import { generateReport } from '../services/clanReports/clanReportService.js';
import { requireRole } from '../utils/permissions.js';
import { errorEmbed } from '../utils/embed.js';
import config from '../config.js';
import logger from '../logger.js';

const log = logger.child({ module: 'clanReports:buttons' });

const staffRoles = () => config.prospects?.roles || [];

export async function handleWindowSwitch(interaction) {
  // cr_window:<clanId>:<serverId>:<window>
  const parts = interaction.customId.split(':');
  const clanId = parts[1];
  const serverId = parts[2];
  const window = parts[3];

  try {
    await interaction.deferUpdate();
    const view = await buildPickerView({ clanId, serverId, window });
    await interaction.editReply({ embeds: [view.embed], components: view.components });
  } catch (err) {
    log.error({ err, customId: interaction.customId }, 'handleWindowSwitch failed');
    await interaction.followUp({ embeds: [errorEmbed('Failed to update window.')], flags: ['Ephemeral'] }).catch(() => {});
  }
}

export async function handleGenerate(interaction) {
  // cr_panel:<panel>:<clanId>:<serverId>:<window>
  if (await requireRole(interaction, staffRoles())) return;

  const parts = interaction.customId.split(':');
  const panel = parts[1];
  const clanId = parts[2];
  const serverId = parts[3];
  const window = parts[4];

  try {
    await interaction.deferUpdate();
    const { attachment, summary } = await generateReport({
      clanId,
      serverId,
      window,
      panel,
      generatedBy: {
        id: interaction.user.id,
        username: interaction.user.username,
        tag: interaction.user.tag || interaction.user.username,
      },
    });
    await interaction.editReply({
      content: summary,
      embeds: [],
      components: [],
      files: [attachment],
    });
  } catch (err) {
    log.error({ err, customId: interaction.customId, userId: interaction.user.id }, 'handleGenerate failed');
    await interaction.followUp({
      embeds: [errorEmbed(`Failed to generate report: ${err.message || 'unknown error'}`)],
      flags: ['Ephemeral'],
    }).catch(() => {});
  }
}
