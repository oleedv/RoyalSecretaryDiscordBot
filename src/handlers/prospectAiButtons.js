import { query } from '../database/connection.js';
import { parseAiSections, buildProspectAiEmbed, buildProspectAiTabRow } from '../services/prospect/prospectEmbeds.js';
import { requireRole } from '../utils/permissions.js';
import config from '../config.js';
import logger from '../logger.js';

const log = logger.child({ module: 'prospectAiButtons' });

const staffRoles = () => config.prospects.roles || [];

export async function handleTabSwitch(interaction) {
  if (await requireRole(interaction, staffRoles())) return;

  const [, section, prospectIdRaw] = interaction.customId.split(':');
  const prospectId = parseInt(prospectIdRaw, 10);
  if (Number.isNaN(prospectId)) return;

  await interaction.deferUpdate();

  const rows = await query('SELECT ai_evaluation FROM prospects WHERE id = ?', [prospectId]);
  const aiText = rows[0]?.ai_evaluation;
  if (!aiText) {
    await interaction.followUp({ content: 'AI assessment unavailable.', flags: ['Ephemeral'] }).catch(() => {});
    return;
  }

  try {
    const sections = parseAiSections(aiText);
    const aiEmbed = buildProspectAiEmbed(section, sections);
    const tabRow = buildProspectAiTabRow(prospectId, section);

    // Replace only the AI embed (last embed) and the tab row (last action row).
    const existingEmbeds = interaction.message.embeds;
    const embeds = [...existingEmbeds.slice(0, -1), aiEmbed];

    const existingComponents = interaction.message.components || [];
    const components = [...existingComponents.slice(0, -1), tabRow];

    await interaction.editReply({ embeds, components });
  } catch (err) {
    log.error({ err, prospectId, section }, 'AI tab switch failed');
  }
}
