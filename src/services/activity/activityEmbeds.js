import { createEmbed } from '../../utils/embed.js';

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function pct(part, total) {
  if (total === 0) return '0%';
  return `${Math.round((part / total) * 100)}%`;
}

function channelList(channels, formatter) {
  if (!channels || channels.length === 0) return 'None';
  return channels.map((c) => `<#${c.id}> - ${formatter(c)}`).join('\n');
}

export function buildActivityEmbed(member, summary, activeSession, days) {
  const { voice, messages, reactions } = summary;
  const userTag = member?.user.tag || 'Unknown';

  const embed = createEmbed('Activity')
    .setTitle(`Activity - ${member?.displayName || userTag}`)
    .setDescription(`Last **${days}** days`)
    .setColor(0x5865f2);

  if (member) {
    embed.setThumbnail(member.user.displayAvatarURL());
  }

  // Voice stats (include active session in totals)
  let totalVoice = voice.totalSeconds;
  let totalMuted = voice.mutedSeconds;
  let totalDeafened = voice.deafenedSeconds;
  let totalStreaming = voice.streamingSeconds;
  let totalVideo = voice.videoSeconds;
  if (activeSession) {
    totalVoice += activeSession.durationSeconds;
    totalMuted += activeSession.mutedSeconds;
    totalDeafened += activeSession.deafenedSeconds;
    totalStreaming += activeSession.streamingSeconds;
    totalVideo += activeSession.videoSeconds;
  }

  const activeVoice = totalVoice - totalMuted - totalDeafened;
  const voiceLines = [
    `Total: **${formatDuration(totalVoice)}** (${voice.sessionCount} sessions)`,
    `Active: **${formatDuration(Math.max(0, activeVoice))}**`,
    `Muted: ${formatDuration(totalMuted)} (${pct(totalMuted, totalVoice)})`,
    `Deafened: ${formatDuration(totalDeafened)} (${pct(totalDeafened, totalVoice)})`,
  ];
  if (totalStreaming > 0) {
    voiceLines.push(`Streaming: ${formatDuration(totalStreaming)}`);
  }
  if (totalVideo > 0) {
    voiceLines.push(`Video: ${formatDuration(totalVideo)}`);
  }
  embed.addFields({ name: 'Voice', value: voiceLines.join('\n') });

  if (voice.topChannels.length > 0) {
    embed.addFields({
      name: 'Top Voice Channels',
      value: channelList(voice.topChannels, (c) => formatDuration(c.seconds)),
    });
  }

  // Live session
  if (activeSession) {
    embed.addFields({
      name: 'Currently In Voice',
      value: `<#${activeSession.channelId}> for ${formatDuration(activeSession.durationSeconds)}`,
    });
  }

  // Message stats
  const msgLines = [`Total: **${messages.totalMessages}** messages`];
  embed.addFields({ name: 'Messages', value: msgLines.join('\n') });

  if (messages.topChannels.length > 0) {
    embed.addFields({
      name: 'Top Message Channels',
      value: channelList(messages.topChannels, (c) => `${c.count} msgs`),
    });
  }

  // Reactions
  embed.addFields({
    name: 'Reactions',
    value: `${reactions.totalReactions} reactions given`,
    inline: true,
  });

  return embed;
}
