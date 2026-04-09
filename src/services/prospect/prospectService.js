import { randomUUID } from 'crypto';
import { ChannelType, EmbedBuilder } from 'discord.js';
import { createEmbed } from '../../utils/embed.js';
import { buildPrivateChannelPermissions } from '../../utils/permissions.js';
import { findBotMessageByCustomId } from '../../utils/messageSearch.js';
import { buildProspectInfoEmbed, buildForumIntroEmbed, buildProspectComponents, buildProspectAcceptedComponents, buildAcceptedAnnouncementEmbed } from './prospectEmbeds.js';
import * as bm from '../battlemetricsService.js';
import * as whitelistService from '../whitelistService.js';
import { fetchCblData } from '../cblService.js';
import { getSteamBans } from '../steamService.js';
import { getPlaytime, getConnectionStats } from '../playtimeService.js';
import { getPlayerSeedStats, getSeedStreak } from '../seedTracker/seedTrackerService.js';
import { getActivitySummary } from '../activity/activityService.js';
import { generateProspectEvaluation } from '../ai/prospectAiService.js';
import { query, transaction } from '../../database/connection.js';
import { assignTeamRole, removeTeamRole } from './teamRoleService.js';
import config from '../../config.js';
import logger from '../../logger.js';

const log = logger.child({ module: 'prospects' });

/**
 * Check if a Steam ID is the test/placeholder value "Q".
 */
export function isTestSteamId(id) {
  return !id || id.toUpperCase() === 'Q';
}

/**
 * Calculate period end date, vote date, and paused state for a prospect.
 * Uses period_started_at if set, otherwise falls back to created_at.
 */
export function getProspectDates(prospect) {
  const { periodDays, voteDaysBefore } = config.prospects;
  const extra = prospect.extra_days || 0;
  const totalPeriod = periodDays + extra;
  const daysUntilVote = (periodDays - voteDaysBefore) + extra;

  const baseDate = new Date(prospect.period_started_at || prospect.created_at);
  const periodEnd = new Date(baseDate);
  periodEnd.setDate(periodEnd.getDate() + totalPeriod);
  const voteDate = new Date(baseDate);
  voteDate.setDate(voteDate.getDate() + daysUntilVote);

  return { periodEnd, voteDate, isPaused: !!prospect.paused_at };
}

function formatCblEmbed(cblData) {
  const riskRating = cblData?.riskRating ?? 0;
  const repPoints = cblData?.reputationPoints ?? 0;
  const bans = cblData?.bans?.edges?.map((e) => e.node) ?? [];

  const expiredCount = cblData?.expiredBans?.edges?.length ?? 0;

  let text = `**Risk:** ${riskRating}/10 · **Rep:** ${repPoints} pts · **Expired Bans:** ${expiredCount}`;

  if (bans.length === 0) {
    text += '\nNo active bans';
  } else {
    text += `\n**Active Bans (${bans.length}):**`;
    for (const ban of bans) {
      const org = ban.banList?.organisation?.name || 'Unknown';
      const reason = ban.reason || 'No reason';
      const created = ban.created ? `<t:${Math.floor(new Date(ban.created).getTime() / 1000)}:d>` : '?';
      const expiry = ban.expires
        ? `expires <t:${Math.floor(new Date(ban.expires).getTime() / 1000)}:d>`
        : 'permanent';
      text += `\n> **${org}**\n> ${reason} (${created}, ${expiry})`;
    }
  }

  return text;
}

// ── Combined Stats + CBL Append ──

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function pct(part, total) {
  if (total === 0) return '0%';
  return `${Math.round((part / total) * 100)}%`;
}

function formatBmBans(bmBans) {
  let text = `**Active:** ${bmBans.activeBans.length} | **Expired:** ${bmBans.expiredBanCount}`;

  if (bmBans.activeBans.length === 0) {
    text += '\nNo active bans';
  } else {
    const shown = bmBans.activeBans.slice(0, 5);
    for (const ban of shown) {
      const created = ban.created ? `<t:${Math.floor(new Date(ban.created).getTime() / 1000)}:d>` : '?';
      const expiry = ban.permanent ? 'permanent' : ban.expires
        ? `expires <t:${Math.floor(new Date(ban.expires).getTime() / 1000)}:d>`
        : 'permanent';
      const reason = ban.reason.length > 80 ? ban.reason.slice(0, 77) + '...' : ban.reason;
      text += `\n> **${ban.serverName}**\n> ${reason} (${created}, ${expiry})`;
    }
    if (bmBans.activeBans.length > 5) {
      text += `\n> *... and ${bmBans.activeBans.length - 5} more*`;
    }
  }

  return text;
}

function appendAllStatsToMessage(message, steamId, userId, prospect) {
  if (isTestSteamId(steamId)) return;

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 90);
  const start = startDate.toISOString().slice(0, 10);
  const now = new Date().toISOString().slice(0, 10);

  Promise.all([
    getConnectionStats(steamId, start).catch(() => null),
    getPlaytime(steamId, start).catch(() => null),
    getPlayerSeedStats(steamId, 30).catch(() => null),
    getSeedStreak(steamId).catch(() => 0),
    getActivitySummary(userId, start, now).catch(() => null),
    fetchCblData(steamId).catch(() => null),
    bm.getPlayerBans(steamId).catch(() => null),
    getSteamBans(steamId).catch(() => null),
  ]).then(async ([connStats, playtime, seedStats, seedStreak, activity, cblData, bmBans, steamBans]) => {
    const embed = message.embeds[0];
    if (!embed) return;

    const updated = EmbedBuilder.from(embed);
    const fields = [];

    // Game Activity
    if (connStats || playtime) {
      const lines = [];
      if (playtime) lines.push(`Playtime: **${playtime.playtimeHours}h**`);
      if (connStats) {
        lines.push(`Connections: **${connStats.connections}**`);
        if (connStats.avgSessionHours > 0) lines.push(`Avg Session: **${connStats.avgSessionHours}h**`);
        if (connStats.firstSeen) lines.push(`First Seen: <t:${Math.floor(new Date(connStats.firstSeen).getTime() / 1000)}:d>`);
        if (connStats.lastSeen) lines.push(`Last Seen: <t:${Math.floor(new Date(connStats.lastSeen).getTime() / 1000)}:R>`);
      }
      fields.push({ name: 'Game Activity (90d)', value: lines.join('\n'), inline: true });
    }

    // Seeding
    if (seedStats || playtime) {
      const lines = [];
      if (playtime) lines.push(`Seed Hours: **${playtime.seedHours}h**`);
      if (seedStats) {
        lines.push(`Seed Days: **${seedStats.uniqueDays}** (30d)`);
        if (seedStreak > 0) lines.push(`Streak: **${seedStreak}** day(s)`);
        if (seedStats.avgQuality != null) lines.push(`Quality: **${seedStats.avgQuality.toFixed(1)}**/10`);
        if (seedStats.lastSeedDate) lines.push(`Last Seed: <t:${Math.floor(new Date(seedStats.lastSeedDate).getTime() / 1000)}:d>`);
      }
      fields.push({ name: 'Seeding (30d)', value: lines.join('\n'), inline: true });
    }

    // Discord Activity
    if (activity) {
      const { voice, messages, reactions } = activity;
      const lines = [];
      if (voice.totalSeconds > 0) {
        const activeSeconds = Math.max(0, voice.totalSeconds - voice.mutedSeconds - voice.deafenedSeconds);
        lines.push(`Voice: **${formatDuration(voice.totalSeconds)}** (${pct(activeSeconds, voice.totalSeconds)} active)`);
        if (voice.mutedSeconds > 0) lines.push(`Muted: ${pct(voice.mutedSeconds, voice.totalSeconds)} | Deafened: ${pct(voice.deafenedSeconds, voice.totalSeconds)}`);
      } else {
        lines.push('Voice: **0h**');
      }
      lines.push(`Messages: **${messages.totalMessages}**`);
      if (messages.topChannels.length > 0) {
        const top = messages.topChannels.slice(0, 3).map((c) => `<#${c.id}>`).join(', ');
        lines.push(`Active in: ${top}`);
      }
      if (reactions.totalReactions > 0) lines.push(`Reactions: **${reactions.totalReactions}**`);
      fields.push({ name: 'Discord Activity (90d)', value: lines.join('\n'), inline: true });
    }

    // Community Ban List
    if (cblData) {
      fields.push({ name: 'Community Ban List', value: formatCblEmbed(cblData) });
    }

    // BattleMetrics Bans
    if (bmBans) {
      const bmText = formatBmBans(bmBans);
      fields.push({ name: 'BattleMetrics Bans', value: bmText.length > 1024 ? bmText.slice(0, 1021) + '...' : bmText });
    }

    // Steam Bans (VAC / Game Bans)
    if (steamBans) {
      const lines = [];
      if (steamBans.vacBanned) {
        lines.push(`VAC Banned: **Yes** (${steamBans.numberOfVacBans} ban${steamBans.numberOfVacBans !== 1 ? 's' : ''})`);
      } else {
        lines.push('VAC Banned: **No**');
      }
      if (steamBans.numberOfGameBans > 0) {
        lines.push(`Game Bans: **${steamBans.numberOfGameBans}**`);
      }
      if (steamBans.daysSinceLastBan > 0 && (steamBans.vacBanned || steamBans.numberOfGameBans > 0)) {
        lines.push(`Days Since Last Ban: **${steamBans.daysSinceLastBan}**`);
      }
      if (steamBans.communityBanned) {
        lines.push('Community Banned: **Yes**');
      }
      if (steamBans.economyBan && steamBans.economyBan !== 'none') {
        lines.push(`Economy Ban: **${steamBans.economyBan}**`);
      }
      fields.push({ name: 'Steam Bans', value: lines.join('\n'), inline: true });
    }

    const embeds = [];

    if (fields.length > 0) {
      updated.addFields(fields);
    }
    embeds.push(updated);

    // AI Assessment as a separate embed
    if (prospect) {
      try {
        const aiText = await generateProspectEvaluation(prospect, {
          connStats, playtime, seedStats, seedStreak, activity, cblData, bmBans, steamBans,
        });
        if (aiText) {
          const truncated = aiText.length > 4096 ? aiText.slice(0, 4093) + '...' : aiText;
          const aiEmbed = createEmbed('Prospect')
            .setTitle('AI Assessment')
            .setDescription(truncated)
            .setColor(0x5865f2);
          embeds.push(aiEmbed);
        }
      } catch (err) {
        log.warn({ err }, 'Failed to generate AI prospect evaluation');
      }
    }

    message.edit({ embeds }).catch((err) =>
      log.warn({ err }, 'Failed to append stats to prospect embed')
    );
  }).catch((err) => {
    log.warn({ err, steamId }, 'appendAllStatsToMessage failed');
  });
}

// ── DB Accessors ──

export async function getOpenProspectByUser(userId) {
  const rows = await query(
    'SELECT * FROM prospects WHERE user_id = ? AND status = ?',
    [userId, 'open']
  );
  return rows[0] || null;
}

export async function getOpenProspectsByMentor(mentorId) {
  return query('SELECT * FROM prospects WHERE mentor_id = ? AND status = ?', [mentorId, 'open']);
}

export async function getProspectByChannel(channelId) {
  const rows = await query(
    'SELECT * FROM prospects WHERE channel_id = ? AND status = ?',
    [channelId, 'open']
  );
  return rows[0] || null;
}

export async function getProspectByUserWithChannel(userId) {
  const rows = await query(
    'SELECT * FROM prospects WHERE user_id = ? AND channel_id IS NOT NULL AND status IN (?, ?) ORDER BY created_at DESC LIMIT 1',
    [userId, 'accepted', 'denied']
  );
  return rows[0] || null;
}

export async function getProspectByChannelAnyStatus(channelId) {
  const rows = await query(
    'SELECT * FROM prospects WHERE channel_id = ? ORDER BY created_at DESC LIMIT 1',
    [channelId]
  );
  return rows[0] || null;
}

export async function getProspectsNeedingVote() {
  const { periodDays, voteDaysBefore } = config.prospects;
  const daysUntilVote = periodDays - voteDaysBefore;
  return await query(
    'SELECT * FROM prospects WHERE status = ? AND forum_thread_id IS NOT NULL AND vote_posted_at IS NULL AND paused_at IS NULL AND TIMESTAMPDIFF(DAY, COALESCE(period_started_at, created_at), NOW()) >= (? + COALESCE(extra_days, 0))',
    ['open', daysUntilVote]
  );
}

export async function saveProspectMessage(prospectId, authorId, authorTag, content, attachments, isStaff, sourceMessageId, channelMessageId) {
  await query(
    'INSERT INTO prospect_messages (prospect_id, author_id, author_tag, content, attachments, is_staff, source_message_id, channel_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [prospectId, authorId, authorTag, content, JSON.stringify(attachments || []), isStaff ? 1 : 0, sourceMessageId || null, channelMessageId || null]
  );
}

// ── Operations ──

export async function createProspect(userId, guild, formData) {
  const existing = await getOpenProspectByUser(userId);
  if (existing) return { error: 'You already have an open prospect application.' };

  const uuid = randomUUID();
  const shortId = uuid.slice(0, 6);
  const { categoryId, roles, prospectRoleId, mentorRoleId } = config.prospects;

  const permissionOverwrites = buildPrivateChannelPermissions(guild, roles);

  const channel = await guild.channels.create({
    name: `prospect-${formData.alias.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${shortId}`,
    type: ChannelType.GuildText,
    parent: categoryId || undefined,
    permissionOverwrites,
  });

  let prospect;
  try {
    await query(
      `INSERT INTO prospects (uuid, channel_id, user_id, alias, nationality, date_of_birth, squad_hours, preferred_roles, prev_clan, why_rb, active_hours, competitive, steam_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuid, channel.id, userId, formData.alias, formData.nationality, formData.dateOfBirth, formData.squadHours, formData.preferredRoles, formData.prevClan, formData.whyRb, formData.activeHours, formData.competitive, formData.steamId]
    );

    const rows = await query('SELECT * FROM prospects WHERE uuid = ?', [uuid]);
    prospect = rows[0];

    await query(
      'INSERT INTO prospect_events (prospect_id, event_type, actor_id) VALUES (?, ?, ?)',
      [prospect.id, 'created', userId]
    );
  } catch (err) {
    log.error({ err, uuid, channelId: channel.id }, 'Failed to insert prospect record, cleaning up channel');
    await channel.delete().catch(() => null);
    throw err;
  }

  const member = await guild.members.fetch(userId).catch(() => null);
  const infoEmbed = buildProspectInfoEmbed(member, prospect);
  const components = buildProspectComponents(prospect);

  const topMsg = await channel.send({ embeds: [infoEmbed], components });
  appendAllStatsToMessage(topMsg, prospect.steam_id, prospect.user_id, prospect);

  if (mentorRoleId) {
    await channel.send(`<@&${mentorRoleId}> New prospect application!`);
  }

  if (prospectRoleId && member) {
    await member.roles.add(prospectRoleId).catch((err) =>
      log.error({ err, userId }, 'Failed to add prospect role')
    );
  }

  const user = await guild.client.users.fetch(userId).catch(() => null);
  if (user) {
    const dmEmbed = createEmbed('Prospect')
      .setTitle('Application Received')
      .setDescription('Your application to **Royal Battalion** has been received! A mentor will contact you shortly.')
      .setColor(0x5865f2);
    await user.send({ embeds: [dmEmbed] }).catch(() => null);
  }

  log.info({ uuid, userId, channelId: channel.id }, 'Prospect created');
  return { prospect, channel };
}

export async function claimProspect(prospect, mentorId, guild) {
  if (prospect.mentor_id) return { error: 'This prospect already has a mentor.' };

  const result = await query('UPDATE prospects SET mentor_id = ? WHERE id = ? AND mentor_id IS NULL', [mentorId, prospect.id]);
  if (result.affectedRows === 0) return { error: 'Another mentor just claimed this prospect.' };

  const mentor = await guild.members.fetch(mentorId).catch(() => null);
  const mentorTag = mentor?.user.tag || mentorId;

  const staffChannel = await guild.channels.fetch(prospect.channel_id).catch(() => null);
  if (staffChannel) {
    const member = await guild.members.fetch(prospect.user_id).catch(() => null);
    const updated = (await query('SELECT * FROM prospects WHERE id = ?', [prospect.id]))[0];
    const infoEmbed = buildProspectInfoEmbed(member, updated);
    const components = buildProspectComponents(updated);

    const topMsg = await findBotMessageByCustomId(staffChannel, guild.client.user.id, ['prospect_claim', 'prospect_accept', 'prospect_deny']);
    if (topMsg) {
      await topMsg.edit({ embeds: [infoEmbed], components });
      appendAllStatsToMessage(topMsg, updated.steam_id, updated.user_id, updated);
    }

    const notifEmbed = createEmbed('Prospect')
      .setTitle('Mentor Assigned')
      .setDescription(`**${mentorTag}** has claimed this prospect. DM relay is now active.`)
      .setColor(0x5865f2);
    await staffChannel.send({ embeds: [notifEmbed] });
  }

  const user = await guild.client.users.fetch(prospect.user_id).catch(() => null);
  if (user) {
    const dmEmbed = createEmbed('Prospect')
      .setTitle('Mentor Assigned')
      .setDescription('A mentor has been assigned to you! You can now communicate with them by sending messages here in DMs.')
      .setColor(0x5865f2);
    await user.send({ embeds: [dmEmbed] }).catch(() => null);
  }

  if (!isTestSteamId(prospect.steam_id)) {
    bm.addFlag(prospect.steam_id, config.battlemetrics.prospectFlagId)
      .catch((err) => log.warn({ err }, 'Failed to add BM prospect flag'));
  }

  // Assign the mentor's team role to the prospect
  const roleAssigned = await assignTeamRole(prospect.user_id, mentorId, guild)
  if (!roleAssigned && staffChannel) {
    staffChannel.send({ embeds: [createEmbed('Prospect')
      .setTitle('Team Role Warning')
      .setDescription(`Could not assign the team role to <@${prospect.user_id}>. The claim succeeded but the role may need to be assigned manually.`)
      .setColor(0xfee75c)] }).catch(() => null);
  }

  log.info({ prospectId: prospect.id, mentorId }, 'Mentor claimed prospect');
  return {};
}

export async function unclaimProspect(prospect, actorId, guild) {
  if (!prospect.mentor_id) return { error: 'This prospect does not have a mentor.' };

  // Remove the team role before clearing mentor_id
  await removeTeamRole(prospect.user_id, prospect.mentor_id, guild)

  await query('UPDATE prospects SET mentor_id = NULL WHERE id = ?', [prospect.id]);

  await query(
    'INSERT INTO prospect_events (prospect_id, event_type, actor_id) VALUES (?, ?, ?)',
    [prospect.id, 'unclaimed', actorId]
  );

  const staffChannel = await guild.channels.fetch(prospect.channel_id).catch(() => null);
  if (staffChannel) {
    const member = await guild.members.fetch(prospect.user_id).catch(() => null);
    const updated = (await query('SELECT * FROM prospects WHERE id = ?', [prospect.id]))[0];
    const infoEmbed = buildProspectInfoEmbed(member, updated);
    const components = buildProspectComponents(updated);

    const topMsg = await findBotMessageByCustomId(staffChannel, guild.client.user.id, ['prospect_claim', 'prospect_accept', 'prospect_deny', 'prospect_unclaim']);
    if (topMsg) {
      await topMsg.edit({ embeds: [infoEmbed], components });
      appendAllStatsToMessage(topMsg, updated.steam_id, updated.user_id, updated);
    }

    const actor = await guild.members.fetch(actorId).catch(() => null);
    const actorTag = actor?.user.tag || actorId;
    const notifEmbed = createEmbed('Prospect')
      .setTitle('Mentor Unclaimed')
      .setDescription(`**${actorTag}** has unclaimed this prospect. DM relay is no longer active.`)
      .setColor(0xed4245);
    await staffChannel.send({ embeds: [notifEmbed] });
  }

  log.info({ prospectId: prospect.id, actorId }, 'Mentor unclaimed prospect');
  return {};
}

export async function acceptProspect(prospect, acceptedById, guild) {
  const { forumChannelId, periodDays } = config.prospects;

  const member = await guild.members.fetch(prospect.user_id).catch(() => null);

  let forumThreadId = null;
  const forumChannel = forumChannelId ? await guild.channels.fetch(forumChannelId).catch(() => null) : null;
  if (forumChannel) {
    const introEmbed = buildForumIntroEmbed(member, prospect);

    const thread = await forumChannel.threads.create({
      name: `${prospect.alias} - Prospect Application`,
      message: { embeds: [introEmbed] },
    });
    forumThreadId = thread.id;
  }

  await query(
    'UPDATE prospects SET forum_thread_id = ?, period_started_at = NOW() WHERE id = ?',
    [forumThreadId, prospect.id]
  );

  await query(
    'INSERT INTO prospect_events (prospect_id, event_type, actor_id, detail) VALUES (?, ?, ?, ?)',
    [prospect.id, 'accepted', acceptedById, 'Interview passed - prospect period started']
  );

  const staffChannel = await guild.channels.fetch(prospect.channel_id).catch(() => null);
  if (staffChannel) {
    const forumUrl = forumThreadId ? `https://discord.com/channels/${guild.id}/${forumThreadId}` : null;

    const updated = (await query('SELECT * FROM prospects WHERE id = ?', [prospect.id]))[0];
    const infoEmbed = buildProspectInfoEmbed(member, updated, forumUrl);
    const components = buildProspectAcceptedComponents(updated);

    const topMsg = await findBotMessageByCustomId(staffChannel, guild.client.user.id, ['prospect_accept', 'prospect_deny']);
    if (topMsg) {
      await topMsg.edit({ embeds: [infoEmbed], components });
      appendAllStatsToMessage(topMsg, updated.steam_id, updated.user_id, updated);
    }

    const notifEmbed = createEmbed('Prospect')
      .setTitle('Prospect Accepted')
      .setDescription(
        `**${prospect.alias}** has been accepted. Prospect period started (${periodDays} days).` +
        (forumThreadId ? `\n[View Forum Thread](https://discord.com/channels/${guild.id}/${forumThreadId})` : '')
      )
      .setColor(0x57f287);
    await staffChannel.send({ embeds: [notifEmbed] });
  }

  if (member) {
    try {
      await member.setNickname(`P | ${member.displayName}`);
    } catch (err) {
      log.error({ err, userId: prospect.user_id }, 'Failed to set P | nickname');
      if (staffChannel) {
        staffChannel.send({ embeds: [createEmbed('Prospect')
          .setTitle('Nickname Change Failed')
          .setDescription(`Could not set nickname to **P | ${member.displayName}** for <@${prospect.user_id}>.\nError: ${err.message}`)
          .setColor(0xed4245)] }).catch(() => null);
      }
    }
  }

  const user = await guild.client.users.fetch(prospect.user_id).catch(() => null);
  if (user) {
    const dmEmbed = createEmbed('Prospect')
      .setTitle('Interview Passed')
      .setDescription("Great news! You've passed the interview and have been **accepted** as a prospect in **Royal Battalion**! Your prospect period has now started.")
      .setColor(0x57f287);
    await user.send({ embeds: [dmEmbed] }).catch(() => null);
  }

  log.info({ prospectId: prospect.id, acceptedBy: acceptedById, forumThreadId }, 'Prospect accepted, forum thread created');
}

export async function closeProspect(prospect, closedById, outcome, guild, reason) {
  const statusMap = { accepted: 'accepted', denied: 'denied', closed: 'closed' };
  const status = statusMap[outcome] || 'closed';

  await transaction(async (conn) => {
    await conn.query(
      'UPDATE prospects SET status = ?, closed_at = NOW(), closed_by = ? WHERE id = ?',
      [status, closedById, prospect.id]
    );
    await conn.query(
      'INSERT INTO prospect_events (prospect_id, event_type, actor_id, detail) VALUES (?, ?, ?, ?)',
      [prospect.id, status === 'closed' ? 'closed' : status, closedById, reason || null]
    );
  });

  if (prospect.forum_thread_id) {
    const { forumChannelId } = config.prospects;
    const forumChannel = forumChannelId ? await guild.channels.fetch(forumChannelId).catch(() => null) : null;
    if (forumChannel) {
      const thread = await forumChannel.threads.fetch(prospect.forum_thread_id).catch(() => null);
      if (thread) {
        await thread.delete().catch((err) =>
          log.error({ err, threadId: prospect.forum_thread_id }, 'Failed to delete forum thread')
        );
      }
    }
  }

  const { prospectRoleId, whitelistRoleId } = config.prospects;

  // Remove team role if mentor was assigned
  if (prospect.mentor_id) {
    await removeTeamRole(prospect.user_id, prospect.mentor_id, guild)
  }

  const member = await guild.members.fetch(prospect.user_id).catch(() => null);
  if (member) {
    if (prospectRoleId) await member.roles.remove(prospectRoleId).catch(() => null);
    if (whitelistRoleId) await member.roles.remove(whitelistRoleId).catch(() => null);

    if (outcome === 'accepted') {
      const strippedName = member.displayName.replace(/^P \| /, '');
      try {
        await member.setNickname(`RB | ${strippedName}`);
      } catch (err) {
        log.error({ err, userId: prospect.user_id }, 'Failed to set RB | nickname');
        const ch = await guild.channels.fetch(prospect.channel_id).catch(() => null);
        if (ch) {
          ch.send({ embeds: [createEmbed('Prospect')
            .setTitle('Nickname Change Failed')
            .setDescription(`Could not set nickname to **RB | ${strippedName}** for <@${prospect.user_id}>.\nError: ${err.message}`)
            .setColor(0xed4245)] }).catch(() => null);
        }
      }
    } else {
      const currentName = member.displayName;
      if (currentName.startsWith('P | ')) {
        await member.setNickname(currentName.replace(/^P \| /, '')).catch((err) =>
          log.error({ err, userId: prospect.user_id }, 'Failed to strip P | nickname')
        );
      }
    }
  }

  if (!isTestSteamId(prospect.steam_id)) {
    bm.removeFlag(prospect.steam_id, config.battlemetrics.prospectFlagId)
      .catch((err) => log.warn({ err }, 'Failed to remove BM prospect flag'));
    if (outcome === 'accepted') {
      bm.addFlag(prospect.steam_id, config.battlemetrics.memberFlagId)
        .catch((err) => log.warn({ err }, 'Failed to add BM member flag'));
    }

    if (outcome === 'accepted') {
      whitelistService.updateRole(prospect.steam_id, 'Prospect', 'RBMembers')
        .catch((err) => log.warn({ err }, 'Failed to update whitelist role to member'));
    } else {
      whitelistService.expireByRole(prospect.steam_id, 'Prospect')
        .catch((err) => log.warn({ err }, 'Failed to expire prospect whitelist entry'));
    }
  }

  if (outcome === 'accepted') {
    const { loungeChannelId } = config.prospects;
    if (loungeChannelId) {
      const loungeChannel = await guild.channels.fetch(loungeChannelId).catch(() => null);
      if (loungeChannel) {
        const announceEmbed = buildAcceptedAnnouncementEmbed(member, prospect);
        await loungeChannel.send({ embeds: [announceEmbed] }).catch((err) =>
          log.error({ err, prospectId: prospect.id }, 'Failed to send accepted announcement to lounge')
        );
      }
    }
  }

  const user = await guild.client.users.fetch(prospect.user_id).catch(() => null);
  if (user) {
    const dmEmbeds = {
      accepted: createEmbed('Prospect')
        .setTitle('Welcome to Royal Battalion')
        .setDescription('Congratulations! Your application to **Royal Battalion** has been **accepted**! Welcome to the team.')
        .setColor(0x57f287),
      denied: createEmbed('Prospect')
        .setTitle('Application Denied')
        .setDescription(
          reason
            ? `Your application to **Royal Battalion** has been **denied**.\n\n**Reason:** ${reason}\n\nThank you for your interest.`
            : 'Your application to **Royal Battalion** has been **denied**. Thank you for your interest.'
        )
        .setColor(0xed4245),
      closed: createEmbed('Prospect')
        .setTitle('Application Closed')
        .setDescription('Your prospect application has been closed.')
        .setColor(0x95a5a6),
    };
    const dmEmbed = dmEmbeds[outcome] || dmEmbeds.closed;
    await user.send({ embeds: [dmEmbed] }).catch(() => null);
  }

  log.info({ prospectId: prospect.id, closedBy: closedById, outcome }, 'Prospect closed');
}

export async function togglePause(prospect, actorId, guild) {
  const isPaused = !!prospect.paused_at;

  if (isPaused) {
    const pausedMs = Date.now() - new Date(prospect.paused_at).getTime();
    const pausedDays = Math.ceil(pausedMs / (24 * 60 * 60 * 1000));
    await query(
      'UPDATE prospects SET paused_at = NULL, extra_days = COALESCE(extra_days, 0) + ? WHERE id = ?',
      [pausedDays, prospect.id]
    );
    await query(
      'INSERT INTO prospect_events (prospect_id, event_type, actor_id, detail) VALUES (?, ?, ?, ?)',
      [prospect.id, 'unpaused', actorId, `Paused for ${pausedDays} day(s)`]
    );
    log.info({ prospectId: prospect.id, pausedDays }, 'Prospect unpaused');
  } else {
    await query('UPDATE prospects SET paused_at = NOW() WHERE id = ?', [prospect.id]);
    await query(
      'INSERT INTO prospect_events (prospect_id, event_type, actor_id) VALUES (?, ?, ?)',
      [prospect.id, 'paused', actorId]
    );
    log.info({ prospectId: prospect.id }, 'Prospect paused');
  }

  await refreshStaffEmbed(prospect, guild);
  return { paused: !isPaused };
}

export async function extendProspect(prospect, days, actorId, guild) {
  await query(
    'UPDATE prospects SET extra_days = COALESCE(extra_days, 0) + ? WHERE id = ?',
    [days, prospect.id]
  );
  await query(
    'INSERT INTO prospect_events (prospect_id, event_type, actor_id, detail) VALUES (?, ?, ?, ?)',
    [prospect.id, 'extended', actorId, `+${days} day(s)`]
  );
  log.info({ prospectId: prospect.id, days }, 'Prospect extended');

  await refreshStaffEmbed(prospect, guild);
  await refreshForumEmbed(prospect, guild);
}

export async function refreshStaffEmbed(prospect, guild) {
  const staffChannel = await guild.channels.fetch(prospect.channel_id).catch(() => null);
  if (!staffChannel) return;

  const updated = (await query('SELECT * FROM prospects WHERE id = ?', [prospect.id]))[0];
  const member = await guild.members.fetch(updated.user_id).catch(() => null);
  const forumUrl = updated.forum_thread_id
    ? `https://discord.com/channels/${guild.id}/${updated.forum_thread_id}`
    : null;
  const infoEmbed = buildProspectInfoEmbed(member, updated, forumUrl);
  const components = updated.forum_thread_id
    ? buildProspectAcceptedComponents(updated)
    : buildProspectComponents(updated);

  const topMsg = await findBotMessageByCustomId(staffChannel, guild.client.user.id, ['prospect_claim', 'prospect_accept', 'prospect_deny']);
  if (topMsg) {
    await topMsg.edit({ embeds: [infoEmbed], components });
    appendAllStatsToMessage(topMsg, updated.steam_id, updated.user_id, updated);
  }
}

async function refreshForumEmbed(prospect, guild) {
  const { forumChannelId } = config.prospects;
  if (!forumChannelId) return;

  const updated = (await query('SELECT * FROM prospects WHERE id = ?', [prospect.id]))[0];
  if (!updated?.forum_thread_id) return;

  const forumChannel = await guild.channels.fetch(forumChannelId).catch(() => null);
  if (!forumChannel) return;

  const thread = await forumChannel.threads.fetch(updated.forum_thread_id).catch(() => null);
  if (!thread) return;

  const starterMessage = await thread.fetchStarterMessage().catch(() => null);
  if (!starterMessage) return;

  const member = await guild.members.fetch(updated.user_id).catch(() => null);
  const introEmbed = buildForumIntroEmbed(member, updated);
  await starterMessage.edit({ embeds: [introEmbed] }).catch((err) =>
    log.warn({ err, threadId: updated.forum_thread_id }, 'Failed to update forum intro embed')
  );
}
