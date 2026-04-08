import { SlashCommandBuilder } from 'discord.js';
import { getActivitySummary } from '../services/activity/activityService.js';
import { getActiveSession } from '../services/activity/voiceTracker.js';
import { buildActivityEmbed } from '../services/activity/activityEmbeds.js';
import { errorEmbed } from '../utils/embed.js';
import config from '../config.js';
import logger from '../logger.js';

const log = logger.child({ module: 'cmd:activity' });
const staffRoles = () => config.prospects?.roles || [];

function isStaff(member) {
  return staffRoles().some((roleId) => member.roles.cache.has(roleId));
}

export default {
  data: new SlashCommandBuilder()
    .setName('activity')
    .setDescription('View Discord activity stats for a member')
    .addUserOption((opt) =>
      opt.setName('user').setDescription('Member to check (defaults to yourself)')
    )
    .addIntegerOption((opt) =>
      opt.setName('days').setDescription('Days to look back (default: 30, max: 365)').setMinValue(1).setMaxValue(365)
    ),

  async execute(interaction) {
    const targetUser = interaction.options.getUser('user') || interaction.user;
    const days = interaction.options.getInteger('days') || 30;

    // Non-staff can only view themselves
    if (targetUser.id !== interaction.user.id && !isStaff(interaction.member)) {
      return interaction.reply({
        embeds: [errorEmbed('You can only view your own activity.')],
        flags: ['Ephemeral'],
      });
    }

    await interaction.deferReply({ flags: ['Ephemeral'] });

    try {
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

      const summary = await getActivitySummary(
        targetUser.id,
        startDate.toISOString().slice(0, 10),
        endDate.toISOString().slice(0, 10)
      );

      const activeSession = getActiveSession(targetUser.id);

      const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
      const embed = buildActivityEmbed(member, summary, activeSession, days);

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      log.error({ err, userId: targetUser.id }, 'Activity command failed');
      await interaction.editReply({ embeds: [errorEmbed('Failed to load activity data.')] });
    }
  },
};
