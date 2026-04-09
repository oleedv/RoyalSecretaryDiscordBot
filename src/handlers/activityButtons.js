import { getActivitySummary, getVoiceStats, getMessageStats, getReactionStats, getDailyVoiceBreakdown, getDailyMessageBreakdown, getAfkVoiceSeconds } from '../services/activity/activityService.js';
import { getActiveSession } from '../services/activity/voiceTracker.js';
import { buildOverviewPage, buildVoicePage, buildMessagesPage } from '../services/activity/activityEmbeds.js';
import config from '../config.js';
import logger from '../logger.js';

const log = logger.child({ module: 'activityButtons' });

export async function handleTabSwitch(interaction) {
  const parts = interaction.customId.split(':');
  const tab = parts[1];
  const userId = parts[2];
  const days = parseInt(parts[3], 10) || 30;

  await interaction.deferUpdate();

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const start = startDate.toISOString().slice(0, 10);
  const end = endDate.toISOString().slice(0, 10);

  const member = await interaction.guild.members.fetch(userId).catch(() => null);
  const activeSession = getActiveSession(userId);

  try {
    let result;

    if (tab === 'voice') {
      const [voiceStats, dailyVoice, afkSeconds] = await Promise.all([
        getVoiceStats(userId, start, end),
        getDailyVoiceBreakdown(userId, start, end),
        getAfkVoiceSeconds(userId, start, end, interaction.guild.afkChannelId),
      ]);
      result = buildVoicePage(member, voiceStats, dailyVoice, activeSession, afkSeconds, days, userId);
    } else if (tab === 'messages') {
      const [messageStats, dailyMessages, reactionStats] = await Promise.all([
        getMessageStats(userId, start, end),
        getDailyMessageBreakdown(userId, start, end),
        getReactionStats(userId, start, end),
      ]);
      result = buildMessagesPage(member, messageStats, dailyMessages, reactionStats, days, userId);
    } else {
      const summary = await getActivitySummary(userId, start, end);
      result = buildOverviewPage(member, summary, activeSession, days, userId);
    }

    await interaction.editReply({ embeds: [result.embed], components: result.components });
  } catch (err) {
    log.error({ err, userId, tab }, 'Activity tab switch failed');
    await interaction.editReply({ content: 'Failed to load activity data.' }).catch(() => {});
  }
}
