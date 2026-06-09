import { ChannelType, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import * as db from './tempvoiceService.js';
import { buildControlPanelMessage } from './tempvoiceEmbeds.js';
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

let cleanupInterval = null;
let cachedConfig = null;

// ── Config ──

export async function loadConfig() {
  cachedConfig = await db.getConfig();
  return cachedConfig;
}

export function getConfigCached() {
  return cachedConfig;
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

// ── Channel creation ──

export async function handleJoinTrigger(member, guild) {
  const config = cachedConfig;
  if (!config?.trigger_channel_id || !config?.category_id) return;

  const userId = member.id;

  if (creationLocks.has(userId)) return;
  creationLocks.add(userId);

  try {
    // Check quota
    const maxChannels = config.max_channels_per_user || 3;
    const owned = await db.getTempChannelsByOwner(userId);
    if (owned.length >= maxChannels) {
      log.info({ userId, count: owned.length }, 'User hit temp channel quota');
      return;
    }

    // Load user presets (null if never set)
    const preset = await db.getPreset(userId, guild.id);

    const channelName = preset?.channel_name || `${member.displayName}'s Channel`;

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
    }

    const newChannel = await guild.channels.create({
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
    if (preset?.bitrate) await newChannel.setBitrate(preset.bitrate).catch(() => null);
    if (preset?.region) await newChannel.setRTCRegion(preset.region === 'auto' ? null : preset.region).catch(() => null);
    if (preset?.user_limit) await newChannel.setUserLimit(preset.user_limit).catch(() => null);

    // Move user into the new channel
    await member.voice.setChannel(newChannel).catch(() => null);

    // Send control panel to voice channel text chat
    const panelMessage = await newChannel.send(buildControlPanelMessage());

    // Persist
    await db.createTempChannel(newChannel.id, userId, guild.id, panelMessage.id);
    activeChannels.set(newChannel.id, {
      ownerId: userId,
      guildId: guild.id,
      panelMessageId: panelMessage.id,
      channelName,
    });

    log.info({ userId, channelId: newChannel.id, channelName }, 'Temp channel created');
    await logEvent(guild, 'Channel Created', `<@${userId}> created **${channelName}**`);
  } catch (err) {
    log.error({ err, userId }, 'Failed to create temp channel');
  } finally {
    creationLocks.delete(userId);
  }
}

// ── Channel deletion ──

export async function handleChannelEmpty(channelId, guild) {
  if (!activeChannels.has(channelId)) return;
  if (deletedChannels.has(channelId)) return;

  deletedChannels.add(channelId);

  try {
    const data = activeChannels.get(channelId);
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    const name = channel?.name || data?.channelName || 'Unknown';
    const ownerId = data?.ownerId;

    if (channel) {
      await channel.delete('Temp channel empty').catch(() => null);
    }
    activeChannels.delete(channelId);
    await db.deleteTempChannel(channelId);

    log.info({ channelId, channelName: name, ownerId }, 'Temp channel deleted (empty)');
    if (data) {
      await logEvent(guild, 'Channel Deleted', `**${name}** (owned by <@${ownerId}>) was deleted -- channel empty`);
    }
  } catch (err) {
    log.error({ err, channelId }, 'Failed to delete empty temp channel');
  }

  // Cap deletedChannels set at 1000
  if (deletedChannels.size > 1000) {
    const first = deletedChannels.values().next().value;
    deletedChannels.delete(first);
  }
}

export async function deleteChannelByInteraction(channelId, guild, deletedByUserId) {
  if (!activeChannels.has(channelId)) return;
  deletedChannels.add(channelId);

  const data = activeChannels.get(channelId);
  const name = data?.channelName || 'Unknown';
  const ownerId = data?.ownerId;
  activeChannels.delete(channelId);
  await db.deleteTempChannel(channelId);

  try {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (channel) {
      await channel.delete('Deleted by owner');
    }
  } catch (err) {
    log.error({ err, channelId }, 'Failed to delete temp channel via interaction');
  }

  const actor = deletedByUserId || ownerId;
  await logEvent(guild, 'Channel Deleted', `**${name}** (owned by <@${ownerId}>) was deleted by <@${actor}>`);
}

export async function handleManualChannelDelete(channelId, guild) {
  if (!activeChannels.has(channelId)) return;

  const data = activeChannels.get(channelId);
  const ownerId = data?.ownerId;
  const name = data?.channelName || 'Unknown';

  deletedChannels.add(channelId);
  activeChannels.delete(channelId);
  await db.deleteTempChannel(channelId);

  log.info({ channelId, channelName: name, ownerId }, 'Temp channel deleted (manual)');
  if (guild) {
    await logEvent(guild, 'Channel Deleted', `**${name}** (owned by <@${ownerId}>) was manually deleted`);
  }
}

// ── Ownership ──

export async function transferOwnership(channelId, newOwnerId, guild) {
  const data = activeChannels.get(channelId);
  if (!data) return false;

  const oldOwnerId = data.ownerId;

  try {
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
    await logEvent(guild, 'Ownership Transferred', `**${channelName}**: <@${oldOwnerId}> transferred ownership to <@${newOwnerId}>`);
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

    const transferred = await transferOwnership(channelId, claimerId, guild);
    if (!transferred) return { success: false, reason: 'Failed to transfer ownership.' };

    await logEvent(guild, 'Channel Claimed', `<@${claimerId}> claimed **${channel.name}**`);
    return { success: true };
  } catch (err) {
    log.error({ err, channelId, claimerId }, 'Failed to claim channel');
    return { success: false, reason: 'An error occurred.' };
  }
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

      // Channel exists but is empty -- delete it
      if (channel.members.size === 0) {
        await channel.delete('Cleanup: empty on recovery').catch(() => null);
        await db.deleteTempChannel(row.channel_id);
        cleaned++;
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

// ── Auto-cleanup scheduler ──

export function startCleanupScheduler(client) {
  if (cleanupInterval) return;

  const tick = async () => {
    try {
      const inactive = await db.getInactiveChannels(24);
      if (!inactive.length) return;

      let cleaned = 0;
      for (const row of inactive) {
        try {
          const guild = await client.guilds.fetch(row.guild_id).catch(() => null);
          if (!guild) {
            await db.deleteTempChannel(row.channel_id);
            activeChannels.delete(row.channel_id);
            cleaned++;
            continue;
          }

          const channel = await guild.channels.fetch(row.channel_id).catch(() => null);
          if (!channel) {
            await db.deleteTempChannel(row.channel_id);
            activeChannels.delete(row.channel_id);
            cleaned++;
            continue;
          }

          if (channel.members.size === 0) {
            await channel.delete('Auto-cleanup: inactive 24h+').catch(() => null);
            await db.deleteTempChannel(row.channel_id);
            activeChannels.delete(row.channel_id);
            cleaned++;
          }
        } catch (err) {
          log.error({ err, channelId: row.channel_id }, 'Cleanup error for channel');
        }
      }

      if (cleaned > 0) log.info({ cleaned }, 'Auto-cleanup complete');
    } catch (err) {
      log.error({ err }, 'Auto-cleanup scheduler error');
      reportError(err, { source: 'scheduler:tempvoice:cleanup' }).catch(() => {});
    }
  };

  // First run after 30s, then hourly
  setTimeout(tick, 30_000);
  cleanupInterval = setInterval(tick, 60 * 60 * 1000);
  cleanupInterval.unref();
  log.info('RB Voice cleanup scheduler started');
}

export function stopCleanupScheduler() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

// ── Logging to Discord channel ──

async function logEvent(guild, title, description) {
  const config = cachedConfig;
  if (!config?.log_channel_id) return;

  try {
    const logChannel = await guild.channels.fetch(config.log_channel_id).catch(() => null);
    if (!logChannel) return;

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setAuthor({ name: `RB Voice - ${title}` })
      .setDescription(description)
      .setFooter({ text: 'Royal Secretary - RB Voice log' })
      .setTimestamp();

    await logChannel.send({ embeds: [embed] });
  } catch {
    // Silently fail -- don't break functionality over logging
  }
}

export { logEvent };
