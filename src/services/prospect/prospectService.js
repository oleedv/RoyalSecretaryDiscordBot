import { randomUUID } from 'crypto';
import { ChannelType, EmbedBuilder } from 'discord.js';
import { createEmbed } from '../../utils/embed.js';
import { buildPrivateChannelPermissions } from '../../utils/permissions.js';
import { findBotMessageByCustomId } from '../../utils/messageSearch.js';
import { buildProspectInfoEmbed, buildForumIntroEmbed, buildProspectComponents, buildProspectAcceptedComponents, buildAcceptedAnnouncementEmbed, parseAiSections, buildProspectAiEmbed, buildProspectAiTabRow, AI_DEFAULT_SECTION } from './prospectEmbeds.js';
import * as bm from '../battlemetricsService.js';
import * as whitelistService from '../whitelistService.js';
import { fetchCblData } from '../cblService.js';
import { getSteamBans } from '../steamService.js';
import { getPlaytime, getConnectionStats } from '../playtimeService.js';
import { getPlayerSeedStats, getSeedStreak } from '../seedTracker/seedTrackerService.js';
import { getSeedingConfig } from '../seeding/seedingService.js';
import { getActivitySummary } from '../activity/activityService.js';
import { generateProspectEvaluation } from '../ai/prospectAiService.js';
import { query, transaction } from '../../database/connection.js';
import { assignTeamRole, removeTeamRole } from './teamRoleService.js';
import config from '../../config.js';
import logger from '../../logger.js';

const log = logger.child({ module: 'prospects' });

const STAT_FIELD_NAMES = new Set([
  'Game Activity (90d)',
  'Seeding (30d)',
  'Discord Activity (90d)',
  'Community Ban List',
  'BattleMetrics Bans',
  'BattleMetrics Flags',
  'BattleMetrics Staff Notes',
  'Steam Bans',
]);

const PROSPECT_COLUMNS = [
  'id', 'uuid', 'channel_id', 'forum_thread_id', 'user_id', 'status',
  'alias', 'nationality', 'date_of_birth', 'squad_hours', 'preferred_roles',
  'prev_clan', 'why_rb', 'active_hours', 'competitive', 'steam_id',
  'mentor_id', 'vote_posted_at', 'vote_message_id', 'created_at',
  'closed_at', 'closed_by', 'extra_days', 'paused_at', 'period_started_at',
  'ai_evaluation',
].join(', ');

export async function getProspectById(id) {
  const rows = await query(`SELECT ${PROSPECT_COLUMNS} FROM prospects WHERE id = ?`, [id]);
  return rows[0] || null;
}

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

function formatBmFlags(bmFlags) {
  const shown = bmFlags.slice(0, 10);
  const lines = [];
  for (const f of shown) {
    const name = f.name || 'Unnamed flag';
    const desc = (f.description || '').replace(/\s+/g, ' ').trim();
    const prefix = f.addedAt ? `<t:${Math.floor(new Date(f.addedAt).getTime() / 1000)}:d> — ` : '';
    lines.push(desc ? `${prefix}**${name}** — ${desc}` : `${prefix}**${name}**`);
  }
  if (bmFlags.length > shown.length) {
    lines.push(`*…+${bmFlags.length - shown.length} more*`);
  }
  const text = lines.join('\n');
  return text.length > 1024 ? text.slice(0, 1021) + '...' : text;
}

function formatBmNotes(bmNotes) {
  const MAX_NOTES = 5;
  const PER_NOTE_MAX = 200;
  const shown = bmNotes.slice(0, MAX_NOTES);
  const lines = [];
  for (const n of shown) {
    const text = (n.note || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const truncated = text.length > PER_NOTE_MAX ? text.slice(0, PER_NOTE_MAX - 3) + '...' : text;
    const ts = n.createdAt ? Math.floor(new Date(n.createdAt).getTime() / 1000) : null;
    const prefix = ts ? `<t:${ts}:d> — ` : '';
    lines.push(`${prefix}${truncated}`);
  }
  if (bmNotes.length > shown.length) {
    lines.push(`*…+${bmNotes.length - shown.length} more*`);
  }
  const joined = lines.join('\n');
  return joined.length > 1024 ? joined.slice(0, 1021) + '...' : joined;
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

  getSeedingConfig().catch(() => null).then((seedingCfg) => Promise.all([
    getConnectionStats(steamId, start).catch(() => null),
    getPlaytime(steamId, start).catch(() => null),
    getPlayerSeedStats(steamId, 30, seedingCfg?.tracker_server_id ?? null).catch(() => null),
    getSeedStreak(steamId, seedingCfg?.tracker_server_id ?? null).catch(() => 0),
    getActivitySummary(userId, start, now).catch(() => null),
    fetchCblData(steamId).catch(() => null),
    bm.getPlayerProfile(steamId).catch(() => null),
    getSteamBans(steamId).catch(() => null),
  ]).then(async ([connStats, playtime, seedStats, seedStreak, activity, cblData, bmProfile, steamBans]) => {
    const bmBans = bmProfile?.bans || null;
    const bmNotes = bmProfile?.notes || [];
    const bmFlags = bmProfile?.flags || [];
    const embed = message.embeds[0];
    if (!embed) return;

    const updated = EmbedBuilder.from(embed);
    const existingFields = updated.data.fields || [];
    const kept = existingFields.filter((f) => !STAT_FIELD_NAMES.has(f.name));
    updated.setFields(kept);
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

    // BattleMetrics Flags
    if (bmFlags.length > 0) {
      fields.push({ name: 'BattleMetrics Flags', value: formatBmFlags(bmFlags) });
    }

    // BattleMetrics Staff Notes
    if (bmNotes.length > 0) {
      const notesText = formatBmNotes(bmNotes);
      if (notesText) fields.push({ name: 'BattleMetrics Staff Notes', value: notesText });
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

    const existingCount = updated.data.fields?.length ?? 0;
    const EMBED_FIELD_LIMIT = 25;
    const remaining = Math.max(0, EMBED_FIELD_LIMIT - existingCount);

    if (fields.length > 0) {
      if (fields.length <= remaining) {
        updated.addFields(fields);
        embeds.push(updated);
      } else {
        const primary = fields.slice(0, remaining);
        const overflow = fields.slice(remaining);
        if (primary.length > 0) updated.addFields(primary);
        embeds.push(updated);

        const overflowEmbed = new EmbedBuilder().setTitle('Additional Stats');
        const color = updated.data.color;
        if (color !== undefined && color !== null) overflowEmbed.setColor(color);

        for (let i = 0; i < overflow.length; i += EMBED_FIELD_LIMIT) {
          const chunk = overflow.slice(i, i + EMBED_FIELD_LIMIT);
          const chunkEmbed = i === 0 ? overflowEmbed : new EmbedBuilder().setTitle('Additional Stats (cont.)');
          if (i !== 0 && color !== undefined && color !== null) chunkEmbed.setColor(color);
          chunkEmbed.addFields(chunk);
          embeds.push(chunkEmbed);
        }

        log.warn({ steamId, existingCount, added: fields.length, overflow: overflow.length }, 'prospect embed fields overflowed 25 — spilled into second embed');
      }
    } else {
      embeds.push(updated);
    }

    // AI Assessment as a separate embed with tab buttons.
    // Only generate if not already stored; otherwise reuse the cached evaluation.
    let aiTabRow = null;
    if (prospect) {
      let aiText = prospect.ai_evaluation || null;
      if (!aiText) {
        try {
          aiText = await generateProspectEvaluation(prospect, {
            connStats, playtime, seedStats, seedStreak, activity, cblData, bmBans, bmNotes, bmFlags, steamBans,
          });
          if (aiText) {
            await query('UPDATE prospects SET ai_evaluation = ? WHERE id = ?', [aiText, prospect.id]);
          }
        } catch (err) {
          log.warn({ err }, 'Failed to generate AI prospect evaluation');
        }
      }
      if (aiText) {
        const sections = parseAiSections(aiText);
        embeds.push(buildProspectAiEmbed(AI_DEFAULT_SECTION, sections));
        aiTabRow = buildProspectAiTabRow(prospect.id, AI_DEFAULT_SECTION);
      }
    }

    const editPayload = { embeds };
    if (aiTabRow) {
      const getCustomId = (c) => c?.customId ?? c?.custom_id ?? c?.data?.custom_id ?? null;
      const hasAiTab = (row) => row?.components?.some((c) => getCustomId(c)?.startsWith('prospect_ai_tab:'));
      const kept = (message.components || []).filter((row) => !hasAiTab(row));
      const rows = [...kept, aiTabRow];
      const seen = new Set();
      editPayload.components = rows.filter((row) => {
        const ids = (row?.components || []).map(getCustomId).filter(Boolean);
        if (ids.some((id) => seen.has(id))) return false;
        ids.forEach((id) => seen.add(id));
        return true;
      });
    }
    message.edit(editPayload).catch((err) =>
      log.warn({ err }, 'Failed to append stats to prospect embed')
    );
  }).catch((err) => {
    log.warn({ err, steamId }, 'appendAllStatsToMessage failed');
  }));
}

// ── DB Accessors ──

export async function getOpenProspectByUser(userId) {
  const rows = await query(
    `SELECT ${PROSPECT_COLUMNS} FROM prospects WHERE user_id = ? AND status = ?`,
    [userId, 'open']
  );
  return rows[0] || null;
}

export async function getOpenProspectsByMentor(mentorId) {
  return query(`SELECT ${PROSPECT_COLUMNS} FROM prospects WHERE mentor_id = ? AND status = ?`, [mentorId, 'open']);
}

export async function getProspectByChannel(channelId) {
  const rows = await query(
    `SELECT ${PROSPECT_COLUMNS} FROM prospects WHERE channel_id = ? AND status = ?`,
    [channelId, 'open']
  );
  return rows[0] || null;
}

export async function getProspectByUserWithChannel(userId) {
  const rows = await query(
    `SELECT ${PROSPECT_COLUMNS} FROM prospects WHERE user_id = ? AND channel_id IS NOT NULL AND status IN (?, ?) ORDER BY created_at DESC LIMIT 1`,
    [userId, 'accepted', 'denied']
  );
  return rows[0] || null;
}

export async function getProspectByChannelAnyStatus(channelId) {
  const rows = await query(
    `SELECT ${PROSPECT_COLUMNS} FROM prospects WHERE channel_id = ? ORDER BY created_at DESC LIMIT 1`,
    [channelId]
  );
  return rows[0] || null;
}

export async function getProspectByForumThread(forumThreadId) {
  const rows = await query(
    `SELECT ${PROSPECT_COLUMNS} FROM prospects WHERE forum_thread_id = ?`,
    [forumThreadId]
  );
  return rows[0] || null;
}

export async function getProspectsNeedingVote() {
  const { periodDays, voteDaysBefore } = config.prospects;
  const daysUntilVote = periodDays - voteDaysBefore;
  return await query(
    `SELECT ${PROSPECT_COLUMNS} FROM prospects WHERE status = ? AND forum_thread_id IS NOT NULL AND vote_posted_at IS NULL AND paused_at IS NULL AND TIMESTAMPDIFF(DAY, COALESCE(period_started_at, created_at), NOW()) >= (? + COALESCE(extra_days, 0))`,
    ['open', daysUntilVote]
  );
}

export async function getProspectsNeedingVoteEnd() {
  const { periodDays } = config.prospects;
  return await query(
    `SELECT ${PROSPECT_COLUMNS} FROM prospects WHERE status = ? AND vote_posted_at IS NOT NULL AND paused_at IS NULL AND TIMESTAMPDIFF(DAY, COALESCE(period_started_at, created_at), NOW()) >= (? + COALESCE(extra_days, 0))`,
    ['open', periodDays]
  );
}

export async function backfillMissingAiEvaluations(client) {
  const prospects = await query(
    `SELECT ${PROSPECT_COLUMNS} FROM prospects WHERE status = 'open' AND ai_evaluation IS NULL AND channel_id IS NOT NULL`
  );
  if (prospects.length === 0) return;

  log.info({ count: prospects.length }, 'Backfilling missing prospect AI evaluations');

  for (const prospect of prospects) {
    if (isTestSteamId(prospect.steam_id)) continue;
    try {
      const channel = await client.channels.fetch(prospect.channel_id).catch(() => null);
      if (!channel) {
        log.warn({ prospectId: prospect.id, channelId: prospect.channel_id }, 'AI backfill: channel not found');
        continue;
      }
      const topMsg = await findBotMessageByCustomId(channel, client.user.id, ['prospect_claim', 'prospect_accept', 'prospect_deny', 'prospect_unclaim']);
      if (!topMsg) {
        log.warn({ prospectId: prospect.id, channelId: prospect.channel_id }, 'AI backfill: top prospect message not found');
        continue;
      }
      appendAllStatsToMessage(topMsg, prospect.steam_id, prospect.user_id, prospect);
      log.info({ prospectId: prospect.id }, 'AI backfill: dispatched regeneration');
    } catch (err) {
      log.error({ err, prospectId: prospect.id }, 'AI backfill failed for prospect');
    }
  }
}

export async function refreshAllOpenProspectStats(client) {
  const prospects = await query(
    `SELECT ${PROSPECT_COLUMNS} FROM prospects WHERE status = 'open' AND channel_id IS NOT NULL`
  );
  if (prospects.length === 0) return;

  log.info({ count: prospects.length }, 'Hourly prospect stats refresh starting');

  for (const prospect of prospects) {
    if (isTestSteamId(prospect.steam_id)) continue;
    try {
      const channel = await client.channels.fetch(prospect.channel_id).catch(() => null);
      if (!channel) {
        log.warn({ prospectId: prospect.id, channelId: prospect.channel_id }, 'Stats refresh: channel not found');
        continue;
      }
      const topMsg = await findBotMessageByCustomId(channel, client.user.id, ['prospect_claim', 'prospect_accept', 'prospect_deny', 'prospect_unclaim']);
      if (!topMsg) {
        log.warn({ prospectId: prospect.id, channelId: prospect.channel_id }, 'Stats refresh: top prospect message not found');
        continue;
      }
      appendAllStatsToMessage(topMsg, prospect.steam_id, prospect.user_id, prospect);
    } catch (err) {
      log.error({ err, prospectId: prospect.id }, 'Stats refresh failed for prospect');
    }
  }
}

export async function saveProspectMessage(prospectId, authorId, authorTag, content, attachments, isStaff, sourceMessageId, channelMessageId) {
  await query(
    'INSERT INTO prospect_messages (prospect_id, author_id, author_tag, content, attachments, is_staff, source_message_id, channel_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [prospectId, authorId, authorTag, content, JSON.stringify(attachments || []), isStaff ? 1 : 0, sourceMessageId || null, channelMessageId || null]
  );
}

function buildForumMessageRow(prospectId, message) {
  const attachments = Array.from(message.attachments.values()).map((a) => ({
    url: a.url,
    name: a.name,
    contentType: a.contentType,
  }));
  const embeds = message.embeds.map((e) => e.toJSON());
  return [
    prospectId,
    message.id,
    message.author.id,
    message.author.tag,
    message.author.displayAvatarURL?.() || null,
    message.author.bot ? 1 : 0,
    message.content || null,
    JSON.stringify(attachments),
    JSON.stringify(embeds),
    message.createdAt,
  ];
}

export async function saveForumMessage(prospectId, message) {
  const row = buildForumMessageRow(prospectId, message);
  await query(
    `INSERT IGNORE INTO prospect_forum_messages
       (prospect_id, message_id, author_id, author_tag, author_avatar,
        is_bot, content, attachments, embeds, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row
  );
}

export async function backfillForumThread(prospectId, thread) {
  let before = undefined;
  let inserted = 0;
  let scanned = 0;
  while (true) {
    const batch = await thread.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || batch.size === 0) break;

    for (const message of batch.values()) {
      const row = buildForumMessageRow(prospectId, message);
      const result = await query(
        `INSERT IGNORE INTO prospect_forum_messages
           (prospect_id, message_id, author_id, author_tag, author_avatar,
            is_bot, content, attachments, embeds, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row
      );
      scanned++;
      if (result.affectedRows > 0) inserted++;
    }

    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return { inserted, scanned, skipped: scanned - inserted };
}

// ── Operations ──

export async function createProspect(userId, guild, formData) {
  const existing = await getOpenProspectByUser(userId);
  if (existing) return { error: 'You already have an open prospect application.' };

  const uuid = randomUUID();
  const shortId = uuid.slice(0, 6);
  const { categoryId, roles, mentorRoleId } = config.prospects;

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

    const rows = await query(`SELECT ${PROSPECT_COLUMNS} FROM prospects WHERE uuid = ?`, [uuid]);
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
  const bmPlayerId = !isTestSteamId(prospect.steam_id) ? await bm.resolvePlayerId(prospect.steam_id) : null;
  const infoEmbed = buildProspectInfoEmbed(member, prospect, null, bmPlayerId);
  const components = buildProspectComponents(prospect);

  const topMsg = await channel.send({ embeds: [infoEmbed], components });
  appendAllStatsToMessage(topMsg, prospect.steam_id, prospect.user_id, prospect);

  if (mentorRoleId) {
    await channel.send(`<@&${mentorRoleId}> New prospect application!`);
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
    const updated = (await query(`SELECT ${PROSPECT_COLUMNS} FROM prospects WHERE id = ?`, [prospect.id]))[0];
    const bmPlayerId = !isTestSteamId(updated.steam_id) ? await bm.resolvePlayerId(updated.steam_id) : null;
    const infoEmbed = buildProspectInfoEmbed(member, updated, null, bmPlayerId);
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

export async function unclaimProspect(prospect, actorId, guild, reason = null) {
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
    const updated = (await query(`SELECT ${PROSPECT_COLUMNS} FROM prospects WHERE id = ?`, [prospect.id]))[0];
    const bmPlayerId = !isTestSteamId(updated.steam_id) ? await bm.resolvePlayerId(updated.steam_id) : null;
    const infoEmbed = buildProspectInfoEmbed(member, updated, null, bmPlayerId);
    const components = buildProspectComponents(updated);

    const topMsg = await findBotMessageByCustomId(staffChannel, guild.client.user.id, ['prospect_claim', 'prospect_accept', 'prospect_deny', 'prospect_unclaim']);
    if (topMsg) {
      await topMsg.edit({ embeds: [infoEmbed], components });
      appendAllStatsToMessage(topMsg, updated.steam_id, updated.user_id, updated);
    }

    const actor = await guild.members.fetch(actorId).catch(() => null);
    const actorTag = actor?.user.tag || actorId;
    const description = reason
      ? `**${actorTag}** has been unclaimed from this prospect: ${reason}. DM relay is no longer active.`
      : `**${actorTag}** has unclaimed this prospect. DM relay is no longer active.`;
    const notifEmbed = createEmbed('Prospect')
      .setTitle('Mentor Unclaimed')
      .setDescription(description)
      .setColor(0xed4245);
    await staffChannel.send({ embeds: [notifEmbed] });
  }

  log.info({ prospectId: prospect.id, actorId }, 'Mentor unclaimed prospect');
  return {};
}

export async function acceptProspect(prospect, acceptedById, guild) {
  const { forumChannelId, periodDays, prospectRoleId, purgedRoleId } = config.prospects;

  const member = await guild.members.fetch(prospect.user_id).catch(() => null);

  if (prospectRoleId && member) {
    await member.roles.add(prospectRoleId).catch((err) =>
      log.error({ err, userId: prospect.user_id }, 'Failed to add prospect role')
    );
  }

  let purgedRoleRemoved = false;
  if (purgedRoleId && member?.roles.cache.has(purgedRoleId)) {
    try {
      await member.roles.remove(purgedRoleId);
      purgedRoleRemoved = true;
    } catch (err) {
      log.error({ err, userId: prospect.user_id }, 'Failed to remove Purged role');
    }
  }

  // Guard against double-accept: reserve the row before creating the forum thread.
  const reserveResult = await query(
    'UPDATE prospects SET period_started_at = NOW() WHERE id = ? AND forum_thread_id IS NULL AND period_started_at IS NULL',
    [prospect.id]
  );
  if (reserveResult.affectedRows === 0) {
    log.warn({ prospectId: prospect.id, acceptedById }, 'Accept skipped: prospect already accepted');
    return;
  }

  let forumThreadId = null;
  const forumChannel = forumChannelId ? await guild.channels.fetch(forumChannelId).catch(() => null) : null;
  if (forumChannel) {
    const introEmbed = buildForumIntroEmbed(member, prospect);
    const { memberRoleId, forumTags } = config.prospects;
    const needFeedbackTagId = forumTags?.needFeedback ?? null;

    const thread = await forumChannel.threads.create({
      name: `${prospect.alias} - Prospect Application`,
      appliedTags: needFeedbackTagId ? [needFeedbackTagId] : undefined,
      message: {
        content: memberRoleId
          ? `<@&${memberRoleId}> New prospect **${prospect.alias}**`
          : `New prospect **${prospect.alias}**`,
        embeds: [introEmbed],
        allowedMentions: memberRoleId ? { roles: [memberRoleId] } : { parse: [] },
      },
    });
    forumThreadId = thread.id;
  }

  if (forumThreadId) {
    await query('UPDATE prospects SET forum_thread_id = ? WHERE id = ?', [forumThreadId, prospect.id]);
  }

  await query(
    'INSERT INTO prospect_events (prospect_id, event_type, actor_id, detail) VALUES (?, ?, ?, ?)',
    [prospect.id, 'accepted', acceptedById, 'Interview passed - prospect period started']
  );

  const staffChannel = await guild.channels.fetch(prospect.channel_id).catch(() => null);
  if (staffChannel) {
    const forumUrl = forumThreadId ? `https://discord.com/channels/${guild.id}/${forumThreadId}` : null;

    const updated = { ...prospect, forum_thread_id: forumThreadId, period_started_at: new Date() };
    const bmPlayerId = !isTestSteamId(updated.steam_id) ? await bm.resolvePlayerId(updated.steam_id) : null;
    const infoEmbed = buildProspectInfoEmbed(member, updated, forumUrl, bmPlayerId);
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

    if (purgedRoleRemoved) {
      const purgedEmbed = createEmbed('Prospect')
        .setTitle('Purged Role Removed')
        .setDescription(`Removed the <@&${purgedRoleId}> role from <@${prospect.user_id}>.`)
        .setColor(0x57f287);
      await staffChannel.send({ embeds: [purgedEmbed] });
    }
  }

  if (member) {
    const NICK_PREFIX = 'P | ';
    const MAX_NICK_LENGTH = 32;
    const currentName = member.displayName;
    const baseName = currentName.startsWith(NICK_PREFIX) ? currentName.slice(NICK_PREFIX.length) : currentName;
    const available = MAX_NICK_LENGTH - NICK_PREFIX.length;
    // Slice by code points (not UTF-16 units) so emoji/surrogate pairs aren't split into invalid halves.
    const truncatedBase = [...baseName].slice(0, available).join('');
    const desiredNick = `${NICK_PREFIX}${truncatedBase}`;
    if (currentName !== desiredNick) {
      try {
        await member.setNickname(desiredNick);
      } catch (err) {
        log.error({ err, userId: prospect.user_id }, 'Failed to set P | nickname');
        if (staffChannel) {
          staffChannel.send({ embeds: [createEmbed('Prospect')
            .setTitle('Nickname Change Failed')
            .setDescription(`Could not set nickname to **${desiredNick}** for <@${prospect.user_id}>.\nError: ${err.message}`)
            .setColor(0xed4245)] }).catch(() => null);
        }
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

  // Atomic close: only proceed if the prospect is still open. Affects 0 rows on a duplicate call,
  // preventing duplicate role grants, DMs, lounge announcements, and BM flag changes from concurrent
  // or repeated end-vote / deny clicks.
  const claimed = await transaction(async (conn) => {
    const result = await conn.query(
      "UPDATE prospects SET status = ?, closed_at = NOW(), closed_by = ? WHERE id = ? AND status = 'open'",
      [status, closedById, prospect.id]
    );
    if (result.affectedRows === 0) return false;
    await conn.query(
      'INSERT INTO prospect_events (prospect_id, event_type, actor_id, detail) VALUES (?, ?, ?, ?)',
      [prospect.id, status === 'closed' ? 'closed' : status, closedById, reason || null]
    );
    return true;
  });
  if (!claimed) {
    log.warn({ prospectId: prospect.id, outcome, closedById }, 'closeProspect skipped: prospect already closed');
    return;
  }

  if (prospect.forum_thread_id) {
    const { forumChannelId } = config.prospects;
    const forumChannel = forumChannelId ? await guild.channels.fetch(forumChannelId).catch(() => null) : null;
    if (forumChannel) {
      const thread = await forumChannel.threads.fetch(prospect.forum_thread_id).catch(() => null);
      if (thread) {
        try {
          const flushResult = await backfillForumThread(prospect.id, thread);
          log.info({ prospectId: prospect.id, ...flushResult }, 'Final forum flush before delete');
        } catch (err) {
          log.warn({ err, prospectId: prospect.id }, 'Final forum flush failed; proceeding with delete');
        }
        await thread.delete(`Prospect ${outcome}`).catch((err) =>
          log.warn({ err, threadId: prospect.forum_thread_id }, 'Failed to delete forum thread')
        );
      }
    }
  }

  const { prospectRoleId, memberRoleId, voiceChannelId } = config.prospects;

  // Remove team role if mentor was assigned
  if (prospect.mentor_id) {
    await removeTeamRole(prospect.user_id, prospect.mentor_id, guild)
  }

  if (voiceChannelId) {
    const voiceChannel = await guild.channels.fetch(voiceChannelId).catch(() => null);
    if (voiceChannel?.permissionOverwrites.cache.has(prospect.user_id)) {
      await voiceChannel.permissionOverwrites.delete(prospect.user_id, `Prospect ${outcome}`)
        .catch((err) => log.warn({ err, prospectId: prospect.id, voiceChannelId }, 'Failed to remove prospect voice channel overwrite'));
    }
  }

  const member = await guild.members.fetch(prospect.user_id).catch(() => null);
  if (member) {
    if (prospectRoleId) await member.roles.remove(prospectRoleId).catch(() => null);

    if (outcome === 'accepted' && memberRoleId) {
      await member.roles.add(memberRoleId).catch((err) =>
        log.error({ err, userId: prospect.user_id }, 'Failed to add member role on accept')
      );
    }

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
      whitelistService.updateRole(prospect.steam_id, 'Prospect', 'RBMembers', { clearExpiry: true })
        .catch((err) => log.warn({ err }, 'Failed to update whitelist role to member'));
    } else {
      whitelistService.expireByRole(prospect.steam_id, 'Prospect')
        .catch((err) => log.warn({ err }, 'Failed to expire prospect whitelist entry'));
    }
  }

  const staffChannel = await guild.channels.fetch(prospect.channel_id).catch(() => null);
  if (staffChannel) {
    const roleMention = memberRoleId ? `<@&${memberRoleId}>` : 'the member role';
    const userMention = `<@${prospect.user_id}>`;
    const dbNote = isTestSteamId(prospect.steam_id) ? ' (test steam ID, no DB entry was present)' : '';
    let wlEmbed = null;
    if (outcome === 'accepted') {
      wlEmbed = createEmbed('Prospect')
        .setTitle('Whitelist Promoted')
        .setDescription(`Prospect whitelist upgraded to RBMembers (permanent)${dbNote}. Added ${roleMention} to ${userMention}.`)
        .setColor(0x57f287);
    } else if (outcome === 'denied') {
      wlEmbed = createEmbed('Prospect')
        .setTitle('Whitelist Revoked')
        .setDescription(`Prospect whitelist entry expired${dbNote}. Removed ${roleMention} from ${userMention}.`)
        .setColor(0xed4245);
    } else {
      wlEmbed = createEmbed('Prospect')
        .setTitle('Whitelist Revoked')
        .setDescription(`Prospect whitelist entry expired${dbNote}. Removed ${roleMention} from ${userMention}.`)
        .setColor(0x95a5a6);
    }
    await staffChannel.send({ embeds: [wlEmbed], allowedMentions: { parse: [] } }).catch((err) =>
      log.warn({ err, prospectId: prospect.id }, 'Failed to post whitelist-outcome embed to staff channel')
    );
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
    await user.send({ embeds: [dmEmbed], allowedMentions: { parse: [] } }).catch(() => null);
  }

  log.info({ prospectId: prospect.id, closedBy: closedById, outcome }, 'Prospect closed');
}

export async function togglePause(prospect, actorId, guild) {
  const isPaused = !!prospect.paused_at;

  if (isPaused) {
    // Atomic unpause: compute pausedDays from the stored paused_at in a single UPDATE so concurrent
    // clicks can't both add the same days. Affects 0 rows if another caller already unpaused.
    const result = await query(
      `UPDATE prospects
         SET extra_days = COALESCE(extra_days, 0) + CEIL(TIMESTAMPDIFF(SECOND, paused_at, NOW()) / 86400),
             paused_at = NULL
       WHERE id = ? AND paused_at IS NOT NULL`,
      [prospect.id]
    );
    if (result.affectedRows === 0) {
      log.warn({ prospectId: prospect.id }, 'Unpause skipped: prospect already unpaused');
      await refreshStaffEmbed(prospect, guild);
      return { paused: false };
    }
    const pausedMs = Date.now() - new Date(prospect.paused_at).getTime();
    const pausedDays = Math.ceil(pausedMs / (24 * 60 * 60 * 1000));
    await query(
      'INSERT INTO prospect_events (prospect_id, event_type, actor_id, detail) VALUES (?, ?, ?, ?)',
      [prospect.id, 'unpaused', actorId, `Paused for ${pausedDays} day(s)`]
    );
    log.info({ prospectId: prospect.id, pausedDays }, 'Prospect unpaused');

    await slideProspectWhitelistExpiry(prospect.id, guild, 'unpause');
  } else {
    const result = await query(
      'UPDATE prospects SET paused_at = NOW() WHERE id = ? AND paused_at IS NULL',
      [prospect.id]
    );
    if (result.affectedRows === 0) {
      log.warn({ prospectId: prospect.id }, 'Pause skipped: prospect already paused');
      await refreshStaffEmbed(prospect, guild);
      return { paused: true };
    }
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

  await slideProspectWhitelistExpiry(prospect.id, guild, 'extended');

  await refreshStaffEmbed(prospect, guild);
  await refreshForumEmbed(prospect, guild);
}

async function slideProspectWhitelistExpiry(prospectId, guild, cause) {
  const rows = await query(`SELECT ${PROSPECT_COLUMNS} FROM prospects WHERE id = ?`, [prospectId]);
  const updated = rows[0];
  if (!updated || !updated.vote_posted_at) return;

  const { periodEnd } = getProspectDates(updated);
  const expiryUnix = Math.floor(periodEnd.getTime() / 1000);

  if (!isTestSteamId(updated.steam_id)) {
    await whitelistService.updateExpiryByRole(updated.steam_id, 'Prospect', periodEnd)
      .catch((err) => log.warn({ err, prospectId }, 'Failed to slide prospect whitelist expiry'));
  }

  const staffChannel = await guild.channels.fetch(updated.channel_id).catch(() => null);
  if (staffChannel) {
    const title = cause === 'unpause' ? 'Whitelist Expiry Slid (Unpause)' : 'Whitelist Expiry Extended';
    const description = `Prospect whitelist expiry updated to <t:${expiryUnix}:R> (<t:${expiryUnix}:F>).`;
    const embed = createEmbed('Prospect')
      .setTitle(title)
      .setDescription(description)
      .setColor(0xfee75c);
    await staffChannel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch((err) =>
      log.warn({ err, prospectId }, 'Failed to post whitelist-slide embed to staff channel')
    );
  }
}

export async function refreshStaffEmbed(prospect, guild) {
  const staffChannel = await guild.channels.fetch(prospect.channel_id).catch(() => null);
  if (!staffChannel) return;

  const updated = (await query(`SELECT ${PROSPECT_COLUMNS} FROM prospects WHERE id = ?`, [prospect.id]))[0];
  const member = await guild.members.fetch(updated.user_id).catch(() => null);
  const forumUrl = updated.forum_thread_id
    ? `https://discord.com/channels/${guild.id}/${updated.forum_thread_id}`
    : null;
  const bmPlayerId = !isTestSteamId(updated.steam_id) ? await bm.resolvePlayerId(updated.steam_id) : null;
  const infoEmbed = buildProspectInfoEmbed(member, updated, forumUrl, bmPlayerId);
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

  const updated = (await query(`SELECT ${PROSPECT_COLUMNS} FROM prospects WHERE id = ?`, [prospect.id]))[0];
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
