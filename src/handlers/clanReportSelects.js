// StringSelectMenu handlers for /clanreport.
//
// customId formats:
//   cr_clan_select:<serverId|none>     value=clanId
//   cr_server_select:<clanId|none>     value=serverId

import { buildPickerView } from '../services/clanReports/pickerEmbed.js';
import { errorEmbed } from '../utils/embed.js';
import logger from '../logger.js';

const log = logger.child({ module: 'clanReports:selects' });

function parseSuffix(customId, prefix) {
  const tail = customId.slice(prefix.length);
  return tail === 'none' || tail === '' ? null : tail;
}

export async function handleClanSelect(interaction) {
  const newClanId = interaction.values[0];
  if (!newClanId || newClanId === 'noop') {
    return interaction.deferUpdate().catch(() => {});
  }
  const serverId = parseSuffix(interaction.customId, 'cr_clan_select:');

  try {
    await interaction.deferUpdate();
    const view = await buildPickerView({
      clanId: newClanId,
      serverId,
      window: '30',
    });
    await interaction.editReply({ embeds: [view.embed], components: view.components });
  } catch (err) {
    log.error({ err, customId: interaction.customId }, 'handleClanSelect failed');
    await interaction.followUp({ embeds: [errorEmbed('Failed to update picker.')], flags: ['Ephemeral'] }).catch(() => {});
  }
}

export async function handleServerSelect(interaction) {
  const raw = interaction.values[0];
  if (!raw || raw === 'noop') return interaction.deferUpdate().catch(() => {});
  const newServerId = Number(raw);
  const clanId = parseSuffix(interaction.customId, 'cr_server_select:');

  try {
    await interaction.deferUpdate();
    const view = await buildPickerView({
      clanId,
      serverId: newServerId,
      window: '30',
    });
    await interaction.editReply({ embeds: [view.embed], components: view.components });
  } catch (err) {
    log.error({ err, customId: interaction.customId }, 'handleServerSelect failed');
    await interaction.followUp({ embeds: [errorEmbed('Failed to update picker.')], flags: ['Ephemeral'] }).catch(() => {});
  }
}
