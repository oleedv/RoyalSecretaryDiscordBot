import { ChannelType, PermissionFlagsBits, EmbedBuilder, AuditLogEvent } from 'discord.js';
import * as db from './tempvoiceService.js';
import { buildControlPanelMessage } from './tempvoiceEmbeds.js';
import { getSafeChannelName, findProfanity } from './contentFilter.js';
import logger from '../../logger.js';
import { reportError } from '../admin/errorAlertService.js';

const log = logger.child({ module: 'tempvoice' });

// ── In-memory state ──

const activeChannels = new Map();  // channelId -> { ownerId, guildId, panelMessageId, channelName }
const creationLocks = new Set();   // userId -- prevent race conditions
const deletedChannels = new Set(); // channelId -- prevent double-delete

// Rate limiter: sliding window per user
const rateLimits = new Map(); // userId -> { count, resetAt }
const RATE_LIMIT_WINDOW = 10_000;
const RATE_LIMIT_MAX = 5;

const EMPTY_SWEEP_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const INACTIVE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_MAX_CHANNELS = 1;

let emptySweepInterval = null;
let inactiveCleanupInterval = null;
let cachedConfig = null;

// ── Config ──

export async function loadConfig() {
  cachedConfig = await db.getConfig();
  return cachedConfig;
}

export function getConfigCached() {
  return cachedConfig;
}

function getMaxChannelsPerUser() {
  const n = Number(cachedConfig?.max_channels_per_user);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_CHANNELS;
}

// ── Rate limiting ──

export function checkRateLimit(userId) {
  const now = Date.now();
  const entry = rateLimits.get(userId);

  if (!entry || now > entry.resetAt) {
    rateLimits.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return { allowed: true };
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }

  entry.count++;
  return { allowed: true };
}

// Periodic cleanup of expired entries
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of rateLimits) {
    if (now > entry.resetAt) rateLimits.delete(id);
  }
}, 60_000).unref();

// ── Channel queries ──

export function isTrackedChannel(channelId) {
  return activeChannels.has(channelId);
}

export function getOwner(channelId) {
  return activeChannels.get(channelId)?.ownerId || null;
}

export function isOwner(channelId, userId) {
  return getOwner(channelId) === userId;
}

export function getActiveChannelCount() {
  return activeChannels.size;
}

function capDeletedChannels() {
  while (deletedChannels.size > 1000) {
    const first = deletedChannels.values().next().value;
    deletedChannels.delete(first);
  }
}

/**
 * Delete a tracked temp channel.
 * Discord is deleted first; DB/memory are only cleared after success (or if Discord is already gone).
 * On Discord delete failure, tracking is kept so a later sweep can retry.
 *
 * @returns {Promise<boolean>} true if untracked (and Discord gone or was already gone)
 */
async function deleteTrackedChannel(channelId, guild, opts = {}) {
  const {
    reason = 'Temp channel deleted',
    logReason = 'Deleted',
    actorId = null,
    skipDiscord = false,
    skipLog = false,
  } = opts;

  if (deletedChannels.has(channelId)) return false;

  const data = activeChannels.get(channelId);
  let row = null;
  if (!data) {
    // May still be in DB only (recovery / sweep edge).
    row = await db.getTempChannel(channelId);
    if (!row) return false;
  }

  deletedChannels.add(channelId);

  const ownerId = data?.ownerId || row?.owner_id || null;
  let name = data?.channelName || 'Unknown';

  try {
    if (!skipDiscord && guild) {
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (channel) {
        name = channel.name;
        try {
          await channel.delete(reason);
        } catch (err) {
          // Keep tracking so empty-sweep / leave events can retry.
          deletedChannels.delete(channelId);
          log.error({ err, channelId }, 'Failed to delete Discord temp channel; keeping tracking');
          return false;
        }
      }
    }

    // Discord is gone (deleted by us, already missing, or skipDiscord after external delete).
    activeChannels.delete(channelId);
    await db.deleteTempChannel(channelId);

    log.info({ channelId, channelName: name, ownerId, reason: logReason }, 'Temp channel deleted');

    if (!skipLog && guild) {
      await logEvent(guild, {
        title: 'Channel Deleted',
        actorId: actorId || ownerId,
        channel: { name },
        fields: [
          { name: 'Owner', value: ownerId ? `<@${ownerId}>` : 'Unknown', inline: true },
          { name: 'Reason', value: logReason, inline: true },
        ],
        kind: 'destroy',
      });
    }

    capDeletedChannels();
    return true;
  } catch (err) {
    deletedChannels.delete(channelId);
    log.error({ err, channelId }, 'Failed to finalize temp channel delete');
    return false;
  }
}

// ── Channel creation ──

/**
 * Reconcile channels owned by a user: drop missing, delete empty, return live ones.
 * Used before create so quota / rejoin behaves correctly.
 */
async function reconcileOwnedChannels(userId, guild) {
  const owned = await db.getTempChannelsByOwner(userId);
  const live = [];

  for (const row of owned) {
    const channel = await guild.channels.fetch(row.channel_id).catch(() => null);
    if (!channel) {
      activeChannels.delete(row.channel_id);
      await db.deleteTempChannel(row.channel_id);
      continue;
    }

    if (channel.members.size === 0) {
      // Ensure memory has enough metadata for logging if present
      if (!activeChannels.has(row.channel_id)) {
        activeChannels.set(row.channel_id, {
          ownerId: row.owner_id,
          guildId: row.guild_id,
          panelMessageId: row.panel_message_id,
          channelName: channel.name,
        });
      }
      await deleteTrackedChannel(row.channel_id, guild, {
        reason: 'Empty owned channel on rejoin',
        logReason: 'Empty on rejoin',
      });
      continue;
    }

    if (!activeChannels.has(row.channel_id)) {
      activeChannels.set(row.channel_id, {
        ownerId: row.owner_id,
        guildId: row.guild_id,
        panelMessageId: row.panel_message_id,
        channelName: channel.name,
      });
    }

    live.push(channel);
  }

  return live;
}

export async function handleJoinTrigger(member, guild) {
  const config = cachedConfig;
  if (!config?.trigger_channel_id || !config?.category_id) return;

  const userId = member.id;

  if (creationLocks.has(userId)) return;
  creationLocks.add(userId);

  let createdChannel = null;

  try {
    // Reconcile existing ownership: clean empties, rejoin if at quota
    const liveOwned = await reconcileOwnedChannels(userId, guild);
    const maxChannels = getMaxChannelsPerUser();

    if (liveOwned.length >= maxChannels) {
      const target = liveOwned[0];
      await member.voice.setChannel(target).catch(() => null);
      log.info({ userId, channelId: target.id, count: liveOwned.length }, 'Moved user to existing temp channel (quota)');
      return;
    }

    // Load user presets (null if never set)
    const preset = await db.getPreset(userId, guild.id);

    // Presets are filtered when set, but a profane Discord display name can still
    // leak into the default name -- fall back to a neutral name if so.
    let channelName = preset?.channel_name || `${member.displayName}'s Channel`;
    const creationMatch = findProfanity(channelName);
    if (creationMatch) {
      log.info({ userId, attempted: channelName, matched: creationMatch }, 'Blocked profane name at channel creation');
      channelName = 'Voice Channel';
      await logBlockedName(guild, {
        actor: member.user,
        attempted: preset?.channel_name || `${member.displayName}'s Channel`,
        reason: 'profanity',
        matched: creationMatch,
        source: 'Creation',
      });
    }

    // Build @everyone permissions from preset flags
    const everyoneAllow = [];
    const everyoneDeny = [];

    if (preset?.is_invisible) {
      everyoneDeny.push(PermissionFlagsBits.ViewChannel);
    } else {
      everyoneAllow.push(PermissionFlagsBits.ViewChannel);
    }

    if (preset?.is_locked) {
      everyoneDeny.push(PermissionFlagsBits.Connect);
    } else {
      everyoneAllow.push(PermissionFlagsBits.Connect);
    }

    if (preset?.is_chat_closed) {
      everyoneDeny.push(PermissionFlagsBits.SendMessages);
    }

    if (preset?.is_dnd) {
      everyoneDeny.push(
        PermissionFlagsBits.Speak,
        PermissionFlagsBits.Stream,
        PermissionFlagsBits.UseVAD,
        PermissionFlagsBits.PrioritySpeaker,
        PermissionFlagsBits.UseSoundboard,
        PermissionFlagsBits.UseEmbeddedActivities,
      );
    } else if (config.default_allow_vad ?? 1) {
      everyoneAllow.push(PermissionFlagsBits.UseVAD);
    }

    createdChannel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildVoice,
      parent: config.category_id,
      permissionOverwrites: [
        {
          id: guild.id,
          allow: everyoneAllow,
          deny: everyoneDeny,
        },
        {
          id: guild.client.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.Connect,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.ManageRoles,
          ],
        },
        {
          id: userId,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.Connect,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.MuteMembers,
            PermissionFlagsBits.DeafenMembers,
            PermissionFlagsBits.MoveMembers,
          ],
        },
      ],
    });

    // Apply preset bitrate/region/limit (best-effort, may fail if boost tier changed)
    if (preset?.bitrate) await createdChannel.setBitrate(preset.bitrate).catch(() => null);
    if (preset?.region) await createdChannel.setRTCRegion(preset.region === 'auto' ? null : preset.region).catch(() => null);
    if (preset?.user_limit) await createdChannel.setUserLimit(preset.user_limit).catch(() => null);

    // Move user into the new channel
    await member.voice.setChannel(createdChannel).catch(() => null);

    // Occupancy check: if nobody made it in, delete immediately (no tracking).
    const occupied = await guild.channels.fetch(createdChannel.id).catch(() => null);
    if (!occupied || occupied.members.size === 0) {
      log.info({ userId, channelId: createdChannel.id }, 'Temp channel empty after create; rolling back');
      await createdChannel.delete('Empty after create').catch((err) => {
        log.error({ err, channelId: createdChannel.id }, 'Failed to delete empty-after-create channel');
      });
      createdChannel = null;
      return;
    }

    // Send control panel to voice channel text chat
    const panelMessage = await createdChannel.send(buildControlPanelMessage());

    // Persist only after Discord side is fully set up
    const channelId = createdChannel.id;
    await db.createTempChannel(channelId, userId, guild.id, panelMessage.id);
    activeChannels.set(channelId, {
      ownerId: userId,
      guildId: guild.id,
      panelMessageId: panelMessage.id,
      channelName,
    });
    // Tracked successfully -- do not Discord-rollback on later log failures.
    createdChannel = null;

    log.info({ userId, channelId, channelName }, 'Temp channel created');
    await logEvent(guild, {
      title: 'Channel Created',
      actor: member.user,
      channel: { id: channelId, name: channelName },
      kind: 'create',
    });
  } catch (err) {
    log.error({ err, userId }, 'Failed to create temp channel');
    if (createdChannel) {
      const orphanId = createdChannel.id;
      activeChannels.delete(orphanId);
      await db.deleteTempChannel(orphanId).catch(() => null);
      await createdChannel.delete('Temp channel create failed').catch((delErr) => {
        log.error({ err: delErr, channelId: orphanId }, 'Failed to rollback Discord channel after create error');
      });
    }
  } finally {
    creationLocks.delete(userId);
  }
}

// ── Channel deletion ──

export async function handleChannelEmpty(channelId, guild) {
  if (!activeChannels.has(channelId)) return;
  if (deletedChannels.has(channelId)) return;

  await deleteTrackedChannel(channelId, guild, {
    reason: 'Temp channel empty',
    logReason: 'Channel empty',
  });
}

export async function deleteChannelByInteraction(channelId, guild, deletedByUserId) {
  if (!activeChannels.has(channelId)) return;

  const data = activeChannels.get(channelId);
  await deleteTrackedChannel(channelId, guild, {
    reason: 'Deleted by owner',
    logReason: 'Deleted by owner',
    actorId: deletedByUserId || data?.ownerId,
  });
}

export async function handleManualChannelDelete(channelId, guild) {
  if (!activeChannels.has(channelId)) return;
  // Internal delete already in flight -- skip to avoid duplicate logs.
  if (deletedChannels.has(channelId)) return;

  // Discord channel already gone; only untrack.
  await deleteTrackedChannel(channelId, guild, {
    reason: 'Deleted externally',
    logReason: 'Deleted externally',
    skipDiscord: true,
  });
}

// ── Ownership ──

async function ownerWouldExceedQuota(newOwnerId, excludeChannelId, guild) {
  // Drop empty/missing owned channels so they do not block transfer/claim.
  if (guild) await reconcileOwnedChannels(newOwnerId, guild);

  const maxChannels = getMaxChannelsPerUser();
  const owned = await db.getTempChannelsByOwner(newOwnerId);
  const others = owned.filter((r) => r.channel_id !== excludeChannelId);
  return others.length >= maxChannels;
}

export async function transferOwnership(channelId, newOwnerId, guild) {
  const data = activeChannels.get(channelId);
  if (!data) return false;

  const oldOwnerId = data.ownerId;

  try {
    if (await ownerWouldExceedQuota(newOwnerId, channelId, guild)) {
      log.info({ channelId, newOwnerId }, 'Transfer blocked: new owner at channel quota');
      return false;
    }

    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) return false;

    // Remove old owner perms, add new owner perms
    await channel.permissionOverwrites.edit(oldOwnerId, {
      ManageChannels: null,
      MuteMembers: null,
      DeafenMembers: null,
      MoveMembers: null,
    }).catch(() => null);

    await channel.permissionOverwrites.edit(newOwnerId, {
      ViewChannel: true,
      Connect: true,
      ManageChannels: true,
      MuteMembers: true,
      DeafenMembers: true,
      MoveMembers: true,
    });

    data.ownerId = newOwnerId;
    await db.updateOwner(channelId, newOwnerId);

    log.info({ channelId, oldOwnerId, newOwnerId }, 'Ownership transferred');
    const channelName = channel.name;
    await logEvent(guild, {
      title: 'Ownership Transferred',
      actorId: oldOwnerId,
      channel: { id: channelId, name: channelName },
      fields: [
        { name: 'From', value: `<@${oldOwnerId}>`, inline: true },
        { name: 'To', value: `<@${newOwnerId}>`, inline: true },
      ],
      kind: 'update',
    });
    return true;
  } catch (err) {
    log.error({ err, channelId }, 'Failed to transfer ownership');
    return false;
  }
}

export async function claimChannel(channelId, claimerId, guild) {
  const data = activeChannels.get(channelId);
  if (!data) return { success: false, reason: 'Channel not found.' };

  // Check if current owner is still in the channel
  try {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) return { success: false, reason: 'Channel not found.' };

    if (channel.members.has(data.ownerId)) {
      return { success: false, reason: 'The current owner is still in the channel.' };
    }

    if (await ownerWouldExceedQuota(claimerId, channelId, guild)) {
      return { success: false, reason: 'You already own the maximum number of temp channels.' };
    }

    const transferred = await transferOwnership(channelId, claimerId, guild);
    if (!transferred) return { success: false, reason: 'Failed to transfer ownership.' };

    await logEvent(guild, {
      title: 'Channel Claimed',
      actorId: claimerId,
      channel: { id: channelId, name: channel.name },
      kind: 'create',
    });
    return { success: true };
  } catch (err) {
    log.error({ err, channelId, claimerId }, 'Failed to claim channel');
    return { success: false, reason: 'An error occurred.' };
  }
}

// ── Channel rename guard ──

// Owners hold ManageChannels on their temp channel, so they can rename it via
// Discord's native UI, bypassing the bot's (filtered) rename button. This guard
// catches those direct renames, reverts a blocked name, and logs it.
export async function handleTempChannelRename(oldChannel, newChannel) {
  const data = activeChannels.get(newChannel.id);
  if (!data) return;

  const newName = newChannel.name;
  const result = getSafeChannelName(newName);
  if (result.safe) {
    // Clean rename (including the bot's own renames) -- just keep cache in sync.
    data.channelName = newName;
    return;
  }

  // Prefer reverting to the previous name; fall back to a neutral default if it
  // was also unsafe. Both fallbacks are clean, so the resulting channelUpdate is
  // a no-op and cannot loop.
  const oldName = oldChannel?.name;
  const fallback = oldName && getSafeChannelName(oldName).safe ? oldName : 'Voice Channel';

  await newChannel.setName(fallback).catch((err) => {
    log.error({ err, channelId: newChannel.id }, 'Failed to revert blocked channel rename');
  });
  data.channelName = fallback;

  // Best-effort: attribute the rename via the audit log; fall back to the owner.
  let actorId = data.ownerId;
  try {
    const logs = await newChannel.guild.fetchAuditLogs({ type: AuditLogEvent.ChannelUpdate, limit: 5 });
    const entry = logs.entries.find((e) => e.target?.id === newChannel.id && !e.executor?.bot);
    if (entry?.executor) actorId = entry.executor.id;
  } catch {
    // ViewAuditLog permission may be missing -- ignore.
  }

  log.info({ channelId: newChannel.id, attempted: newName, matched: result.matched, actorId }, 'Reverted blocked channel rename');
  await logBlockedName(newChannel.guild, {
    actorId,
    channel: { id: newChannel.id, name: fallback },
    attempted: newName,
    reason: result.reason,
    matched: result.matched,
    source: 'Direct rename',
  });
}

// ── Voice state handler ──

export async function handleTempVoiceStateUpdate(oldState, newState) {
  if (newState.member?.user?.bot) return;

  const config = cachedConfig;
  if (!config?.trigger_channel_id) return;

  const oldChannelId = oldState.channelId;
  const newChannelId = newState.channelId;

  // User joined the trigger channel
  if (newChannelId === config.trigger_channel_id && oldChannelId !== config.trigger_channel_id) {
    await handleJoinTrigger(newState.member, newState.guild);
    return;
  }

  // User left a temp channel -- check if now empty
  if (oldChannelId && activeChannels.has(oldChannelId) && oldChannelId !== newChannelId) {
    try {
      const channel = await oldState.guild.channels.fetch(oldChannelId).catch(() => null);
      if (channel && channel.members.size === 0) {
        await handleChannelEmpty(oldChannelId, oldState.guild);
      }
    } catch (err) {
      log.error({ err, channelId: oldChannelId }, 'Error checking empty temp channel');
    }
  }

  // Touch activity on join/switch into tracked channel
  if (newChannelId && activeChannels.has(newChannelId)) {
    db.touchActivity(newChannelId).catch(() => null);
  }
}

// ── Recovery ──

export async function initFromDb(client) {
  cachedConfig = await db.getConfig();
  const rows = await db.getAllTempChannels();

  if (!rows.length) {
    log.info('No temp channels to recover');
    return;
  }

  let recovered = 0;
  let cleaned = 0;

  for (const row of rows) {
    try {
      const guild = await client.guilds.fetch(row.guild_id).catch(() => null);
      if (!guild) {
        await db.deleteTempChannel(row.channel_id);
        cleaned++;
        continue;
      }

      const channel = await guild.channels.fetch(row.channel_id).catch(() => null);
      if (!channel) {
        await db.deleteTempChannel(row.channel_id);
        cleaned++;
        continue;
      }

      // Channel exists but is empty -- delete Discord first, then untrack
      if (channel.members.size === 0) {
        activeChannels.set(row.channel_id, {
          ownerId: row.owner_id,
          guildId: row.guild_id,
          panelMessageId: row.panel_message_id,
          channelName: channel.name,
        });
        const ok = await deleteTrackedChannel(row.channel_id, guild, {
          reason: 'Cleanup: empty on recovery',
          logReason: 'Empty on recovery',
          skipLog: true,
        });
        if (ok) cleaned++;
        continue;
      }

      // Channel is active -- restore to memory
      activeChannels.set(row.channel_id, {
        ownerId: row.owner_id,
        guildId: row.guild_id,
        panelMessageId: row.panel_message_id,
        channelName: channel.name,
      });
      recovered++;
    } catch (err) {
      log.error({ err, channelId: row.channel_id }, 'Error recovering temp channel');
    }
  }

  log.info({ recovered, cleaned }, 'Temp channel recovery complete');
}

// ── Auto-cleanup / empty sweep / orphan scan ──

/**
 * Frequent safety net: every tracked channel that is missing or empty is cleaned.
 * Also scans the configured category for empty untracked voice channels (orphans).
 */
async function runEmptySweep(client) {
  let cleaned = 0;

  // 1) Tracked / DB-backed channels
  const rows = await db.getAllTempChannels();
  const seen = new Set();

  for (const row of rows) {
    seen.add(row.channel_id);
    try {
      const guild = await client.guilds.fetch(row.guild_id).catch(() => null);
      if (!guild) {
        activeChannels.delete(row.channel_id);
        await db.deleteTempChannel(row.channel_id);
        cleaned++;
        continue;
      }

      const channel = await guild.channels.fetch(row.channel_id).catch(() => null);
      if (!channel) {
        activeChannels.delete(row.channel_id);
        await db.deleteTempChannel(row.channel_id);
        cleaned++;
        continue;
      }

      if (channel.members.size === 0) {
        if (!activeChannels.has(row.channel_id)) {
          activeChannels.set(row.channel_id, {
            ownerId: row.owner_id,
            guildId: row.guild_id,
            panelMessageId: row.panel_message_id,
            channelName: channel.name,
          });
        }
        const ok = await deleteTrackedChannel(row.channel_id, guild, {
          reason: 'Empty sweep',
          logReason: 'Empty (sweep)',
        });
        if (ok) cleaned++;
      } else if (!activeChannels.has(row.channel_id)) {
        // DB row exists but memory missed it -- re-attach
        activeChannels.set(row.channel_id, {
          ownerId: row.owner_id,
          guildId: row.guild_id,
          panelMessageId: row.panel_message_id,
          channelName: channel.name,
        });
      }
    } catch (err) {
      log.error({ err, channelId: row.channel_id }, 'Empty sweep error for tracked channel');
    }
  }

  // Memory-only entries with no DB row (should be rare)
  for (const [channelId, data] of [...activeChannels.entries()]) {
    if (seen.has(channelId)) continue;
    try {
      const guild = await client.guilds.fetch(data.guildId).catch(() => null);
      if (!guild) {
        activeChannels.delete(channelId);
        cleaned++;
        continue;
      }
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (!channel || channel.members.size === 0) {
        const ok = await deleteTrackedChannel(channelId, guild, {
          reason: 'Empty sweep (memory-only)',
          logReason: 'Empty (sweep)',
        });
        if (ok || !channel) {
          activeChannels.delete(channelId);
          cleaned++;
        }
      }
    } catch (err) {
      log.error({ err, channelId }, 'Empty sweep error for memory-only channel');
    }
  }

  // 2) Orphan scan: empty voice channels in temp category that are not tracked
  const config = cachedConfig;
  if (config?.category_id && config?.trigger_channel_id) {
    try {
      // Prefer guilds that own tracked channels; also walk all guilds for category match
      for (const guild of client.guilds.cache.values()) {
        const category = await guild.channels.fetch(config.category_id).catch(() => null);
        if (!category) continue;

        const children = guild.channels.cache.filter(
          (ch) => ch.parentId === config.category_id && ch.type === ChannelType.GuildVoice,
        );

        for (const channel of children.values()) {
          if (channel.id === config.trigger_channel_id) continue;
          if (activeChannels.has(channel.id)) continue;
          if (seen.has(channel.id)) continue;

          // Re-fetch members
          const fresh = await guild.channels.fetch(channel.id).catch(() => null);
          if (!fresh) continue;
          if (fresh.members.size > 0) {
            log.warn({ channelId: fresh.id, channelName: fresh.name }, 'Untracked non-empty voice channel in temp category');
            continue;
          }

          try {
            await fresh.delete('Orphan empty temp voice channel');
            cleaned++;
            log.info({ channelId: fresh.id, channelName: fresh.name }, 'Deleted orphan empty temp voice channel');
            await logEvent(guild, {
              title: 'Channel Deleted',
              channel: { name: fresh.name },
              fields: [
                { name: 'Reason', value: 'Orphan empty (sweep)', inline: true },
              ],
              kind: 'destroy',
            });
          } catch (err) {
            log.error({ err, channelId: fresh.id }, 'Failed to delete orphan temp channel');
          }
        }
      }
    } catch (err) {
      log.error({ err }, 'Orphan scan error');
    }
  }

  if (cleaned > 0) log.info({ cleaned }, 'Empty/orphan sweep complete');
  return cleaned;
}

async function runInactiveCleanup(client) {
  const inactive = await db.getInactiveChannels(24);
  if (!inactive.length) return 0;

  let cleaned = 0;
  for (const row of inactive) {
    try {
      const guild = await client.guilds.fetch(row.guild_id).catch(() => null);
      if (!guild) {
        activeChannels.delete(row.channel_id);
        await db.deleteTempChannel(row.channel_id);
        cleaned++;
        continue;
      }

      const channel = await guild.channels.fetch(row.channel_id).catch(() => null);
      if (!channel) {
        activeChannels.delete(row.channel_id);
        await db.deleteTempChannel(row.channel_id);
        cleaned++;
        continue;
      }

      if (channel.members.size === 0) {
        if (!activeChannels.has(row.channel_id)) {
          activeChannels.set(row.channel_id, {
            ownerId: row.owner_id,
            guildId: row.guild_id,
            panelMessageId: row.panel_message_id,
            channelName: channel.name,
          });
        }
        const ok = await deleteTrackedChannel(row.channel_id, guild, {
          reason: 'Auto-cleanup: inactive 24h+',
          logReason: 'Inactive 24h+ (empty)',
        });
        if (ok) cleaned++;
      }
    } catch (err) {
      log.error({ err, channelId: row.channel_id }, 'Cleanup error for channel');
    }
  }

  if (cleaned > 0) log.info({ cleaned }, 'Inactive auto-cleanup complete');
  return cleaned;
}

export function startCleanupScheduler(client) {
  if (emptySweepInterval || inactiveCleanupInterval) return;

  const emptyTick = async () => {
    try {
      await runEmptySweep(client);
    } catch (err) {
      log.error({ err }, 'Empty sweep scheduler error');
      reportError(err, { source: 'scheduler:tempvoice:empty-sweep' }).catch(() => {});
    }
  };

  const inactiveTick = async () => {
    try {
      await runInactiveCleanup(client);
    } catch (err) {
      log.error({ err }, 'Inactive cleanup scheduler error');
      reportError(err, { source: 'scheduler:tempvoice:cleanup' }).catch(() => {});
    }
  };

  // Empty sweep: first run after 30s, then every 2 minutes
  setTimeout(emptyTick, 30_000);
  emptySweepInterval = setInterval(emptyTick, EMPTY_SWEEP_INTERVAL_MS);
  emptySweepInterval.unref();

  // Inactive backup: first run after 5m, then hourly
  setTimeout(inactiveTick, 5 * 60_000);
  inactiveCleanupInterval = setInterval(inactiveTick, INACTIVE_CLEANUP_INTERVAL_MS);
  inactiveCleanupInterval.unref();

  log.info('RB Voice cleanup scheduler started (empty sweep 2m, inactive 1h)');
}

export function stopCleanupScheduler() {
  if (emptySweepInterval) {
    clearInterval(emptySweepInterval);
    emptySweepInterval = null;
  }
  if (inactiveCleanupInterval) {
    clearInterval(inactiveCleanupInterval);
    inactiveCleanupInterval = null;
  }
}

// ── Logging to Discord channel ──

const KIND_COLORS = {
  create: 0x57f287,
  destroy: 0xed4245,
  update: 0x5865f2,
  warn: 0xfee75c,
};

async function logEvent(guild, opts) {
  const config = cachedConfig;
  if (!config?.log_channel_id) return;

  try {
    const logChannel = await guild.channels.fetch(config.log_channel_id).catch(() => null);
    if (!logChannel) return;

    const { title, actor = null, actorId = null, channel = null, fields = [], kind = 'update' } = opts;

    let actorUser = actor;
    if (!actorUser && actorId) {
      const member = await guild.members.fetch(actorId).catch(() => null);
      actorUser = member?.user || null;
    }

    const allFields = [];
    if (actorUser) {
      allFields.push({ name: 'User', value: `<@${actorUser.id}> \`${actorUser.id}\``, inline: false });
    }
    if (channel) {
      const value = channel.id
        ? `<#${channel.id}> (\`${channel.name}\`)`
        : `\`${channel.name}\``;
      allFields.push({ name: 'Channel', value, inline: false });
    }
    for (const f of fields) allFields.push(f);

    const author = { name: `RB Voice - ${title}` };
    if (actorUser?.displayAvatarURL) author.iconURL = actorUser.displayAvatarURL();

    const embed = new EmbedBuilder()
      .setColor(KIND_COLORS[kind] ?? KIND_COLORS.update)
      .setAuthor(author)
      .addFields(allFields)
      .setFooter({ text: 'Royal Secretary - RB Voice log' })
      .setTimestamp();

    await logChannel.send({ embeds: [embed] });
  } catch {
    // Silently fail -- don't break functionality over logging
  }
}

export { logEvent };

const BLOCK_REASON_LABELS = {
  profanity: 'Profanity',
  url: 'Link not allowed',
  mention: 'Mention not allowed',
  caps: 'Excessive capitals',
  special: 'Too many symbols',
  length: 'Invalid length',
  empty: 'Empty name',
};

// Post a yellow "blocked name" warning to the RB Voice log channel. Shared by the
// rename button, the direct-rename guard, and channel creation.
export async function logBlockedName(guild, opts) {
  const { actor = null, actorId = null, channel = null, attempted = '', reason = 'profanity', matched = null, source = 'Unknown' } = opts;

  // Channel names are <=100 chars; sanitize backticks so the code span renders.
  const safeAttempted = String(attempted).slice(0, 100).replace(/`/g, "'") || '(empty)';
  let reasonValue = BLOCK_REASON_LABELS[reason] || 'Not allowed';
  if (reason === 'profanity' && matched) reasonValue += ` (\`${matched.replace(/`/g, "'")}\`)`;

  await logEvent(guild, {
    title: 'Blocked Channel Name',
    actor,
    actorId,
    channel,
    fields: [
      { name: 'Attempted name', value: `\`${safeAttempted}\``, inline: false },
      { name: 'Reason', value: reasonValue, inline: true },
      { name: 'Source', value: source, inline: true },
    ],
    kind: 'warn',
  });
}
