import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createEmbed } from '../../utils/embed.js';
import { formatDuration } from '../../utils/formatters.js';

// ── Helpers ──

function pct(part, total) {
  if (total === 0) return '0%';
  return `${Math.round((part / total) * 100)}%`;
}

function formatDate(date) {
  const d = new Date(date);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${String(d.getDate()).padStart(2, '0')}`;
}

function buildBarChart(entries, maxBars = 14) {
  if (!entries || entries.length === 0) return 'No data';
  const BAR_LEN = 8;
  const FULL = '\u2588';
  const EMPTY = '\u2591';
  const slice = entries.slice(-maxBars);
  const max = Math.max(...slice.map((e) => e.value), 1);

  return slice.map(({ label, value, display }) => {
    const filled = Math.round((value / max) * BAR_LEN);
    const bar = FULL.repeat(filled) + EMPTY.repeat(BAR_LEN - filled);
    return `\`${label}\` ${bar} ${display}`;
  }).join('\n');
}

// ── Nav Buttons ──

export function buildNavButtons(activeTab, userId, days) {
  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'voice', label: 'Voice' },
    { id: 'messages', label: 'Messages' },
  ];

  const row = new ActionRowBuilder().addComponents(
    ...tabs.map((tab) =>
      new ButtonBuilder()
        .setCustomId(`activity_tab:${tab.id}:${userId}:${days}`)
        .setLabel(tab.label)
        .setStyle(tab.id === activeTab ? ButtonStyle.Primary : ButtonStyle.Secondary)
    )
  );
  return [row];
}

// ── Overview Page ──

export function buildOverviewPage(member, summary, activeSession, days, userId) {
  const { voice, messages, reactions } = summary;
  const embed = createEmbed('Activity')
    .setTitle(`Activity - ${member?.displayName || userId}`)
    .setDescription(`Last **${days}** days`)
    .setColor(0x5865f2);

  if (member) embed.setThumbnail(member.user.displayAvatarURL());

  // Voice summary (include active session)
  let totalVoice = voice.totalSeconds;
  let totalMuted = voice.mutedSeconds;
  let totalDeafened = voice.deafenedSeconds;
  if (activeSession) {
    totalVoice += activeSession.durationSeconds;
    totalMuted += activeSession.mutedSeconds;
    totalDeafened += activeSession.deafenedSeconds;
  }
  const activeVoice = Math.max(0, totalVoice - totalMuted - totalDeafened);

  const voiceLines = [`**${formatDuration(totalVoice)}** total (${formatDuration(activeVoice)} active, ${formatDuration(totalMuted)} muted, ${formatDuration(totalDeafened)} deafened)`];
  if (activeSession) {
    voiceLines.push(`Currently in <#${activeSession.channelId}> for ${formatDuration(activeSession.durationSeconds)}`);
  }
  embed.addFields({ name: 'Voice', value: voiceLines.join('\n') });

  // Top channels compact (3 each)
  if (voice.topChannels.length > 0) {
    const top3 = voice.topChannels.slice(0, 3).map((c) => `${c.name} (<#${c.id}>) ${formatDuration(c.seconds)}`).join('\n');
    embed.addFields({ name: 'Top Voice Channels', value: top3, inline: true });
  }
  if (messages.topChannels.length > 0) {
    const top3 = messages.topChannels.slice(0, 3).map((c) => `${c.name} (<#${c.id}>) ${c.count}`).join('\n');
    embed.addFields({ name: 'Top Message Channels', value: top3, inline: true });
  }

  // Messages + reactions
  const distinctChannels = messages.topChannels.length;
  embed.addFields({
    name: 'Messages & Reactions',
    value: `**${messages.totalMessages}** messages across ${distinctChannels} channel(s)\n**${reactions.totalReactions}** reactions given`,
  });

  const components = buildNavButtons('overview', userId, days);
  return { embed, components };
}

// ── Voice Detail Page ──

export function buildVoicePage(member, voiceStats, dailyVoice, activeSession, afkSeconds, days, userId) {
  const embed = createEmbed('Activity')
    .setTitle(`Voice - ${member?.displayName || userId}`)
    .setDescription(`Last **${days}** days`)
    .setColor(0x5865f2);

  if (member) embed.setThumbnail(member.user.displayAvatarURL());

  let totalVoice = voiceStats.totalSeconds;
  let totalMuted = voiceStats.mutedSeconds;
  let totalDeafened = voiceStats.deafenedSeconds;
  let totalStreaming = voiceStats.streamingSeconds;
  let totalVideo = voiceStats.videoSeconds;
  if (activeSession) {
    totalVoice += activeSession.durationSeconds;
    totalMuted += activeSession.mutedSeconds;
    totalDeafened += activeSession.deafenedSeconds;
    totalStreaming += activeSession.streamingSeconds;
    totalVideo += activeSession.videoSeconds;
  }
  const activeVoice = Math.max(0, totalVoice - totalMuted - totalDeafened);

  // Breakdown
  const lines = [
    `Total: **${formatDuration(totalVoice)}** (${voiceStats.sessionCount} sessions)`,
    `Active: **${formatDuration(activeVoice)}** (${pct(activeVoice, totalVoice)})`,
    `Muted: ${formatDuration(totalMuted)} (${pct(totalMuted, totalVoice)})`,
    `Deafened: ${formatDuration(totalDeafened)} (${pct(totalDeafened, totalVoice)})`,
  ];
  if (totalStreaming > 0) lines.push(`Streaming: ${formatDuration(totalStreaming)}`);
  if (totalVideo > 0) lines.push(`Video: ${formatDuration(totalVideo)}`);
  if (afkSeconds > 0) lines.push(`AFK: ${formatDuration(afkSeconds)}`);
  embed.addFields({ name: 'Breakdown', value: lines.join('\n') });

  // Live session
  if (activeSession) {
    embed.addFields({
      name: 'Currently In Voice',
      value: `<#${activeSession.channelId}> for ${formatDuration(activeSession.durationSeconds)}`,
    });
  }

  // Top channels
  if (voiceStats.topChannels.length > 0) {
    const list = voiceStats.topChannels.map((c) => `${c.name} (<#${c.id}>) - ${formatDuration(c.seconds)}`).join('\n');
    embed.addFields({ name: 'Top Channels', value: list });
  }

  // Daily trend bar chart
  if (dailyVoice.length > 0) {
    const entries = dailyVoice.map((d) => ({
      label: formatDate(d.date),
      value: d.seconds,
      display: formatDuration(d.seconds),
    }));
    embed.addFields({ name: 'Daily Trend', value: buildBarChart(entries) });
  }

  const components = buildNavButtons('voice', userId, days);
  return { embed, components };
}

// ── Messages Detail Page ──

export function buildMessagesPage(member, messageStats, dailyMessages, reactionStats, days, userId) {
  const embed = createEmbed('Activity')
    .setTitle(`Messages - ${member?.displayName || userId}`)
    .setDescription(`Last **${days}** days`)
    .setColor(0x5865f2);

  if (member) embed.setThumbnail(member.user.displayAvatarURL());

  embed.addFields({
    name: 'Overview',
    value: `**${messageStats.totalMessages}** messages\n**${reactionStats.totalReactions}** reactions given`,
  });

  // Top channels
  if (messageStats.topChannels.length > 0) {
    const list = messageStats.topChannels.map((c) => `${c.name} (<#${c.id}>) - ${c.count} msgs`).join('\n');
    embed.addFields({ name: 'Top Channels', value: list });
  }

  // Daily trend bar chart
  if (dailyMessages.length > 0) {
    const entries = dailyMessages.map((d) => ({
      label: formatDate(d.date),
      value: d.count,
      display: `${d.count}`,
    }));
    embed.addFields({ name: 'Daily Trend', value: buildBarChart(entries) });
  }

  const components = buildNavButtons('messages', userId, days);
  return { embed, components };
}
