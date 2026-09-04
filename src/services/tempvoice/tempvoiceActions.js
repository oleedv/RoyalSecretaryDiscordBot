import {
  isTrackedChannel, getOwner, ensureTracked, snapshotChannel,
  deleteChannelByInteraction, transferOwnership, logEvent, loadConfig,
} from './tempvoiceManager.js';
import * as db from './tempvoiceService.js';
import { getSafeChannelName } from './contentFilter.js';
import {
  MANAGE_OPS, BITRATES, REGIONS,
  everyonePrivacyPatch, dndPermissionPatch, privacyPresetField,
} from './tempvoiceState.js';
import logger from '../../logger.js';

const log = logger.child({ module: 'tempvoice-actions' });

function snowflake(value) {
  return typeof value === 'string' && /^\d{5,25}$/.test(value);
}

export async function applyStaffOp(guild, payload, actorId) {
  const op = payload?.op;
  const channelId = payload?.channelId;
  if (!MANAGE_OPS.has(op)) throw new Error(`Unknown tempvoice op: ${op}`);
  if (!snowflake(channelId)) throw new Error('channelId must be a Discord snowflake');

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    if (op === 'delete') {
      const row = await db.getTempChannel(channelId);
      if (row) await db.deleteTempChannel(channelId);
      return { ok: true, skippedDiscord: true };
    }
    throw new Error(`Temp channel ${channelId} not found on Discord`);
  }

  const tracked = isTrackedChannel(channelId) || await ensureTracked(channel);
  if (!tracked) throw new Error('Not a tracked temp channel');

  const actor = actorId && snowflake(actorId) ? actorId : null;

  switch (op) {
    case 'rename':
      return renameChannel(guild, channel, payload.name, actor);
    case 'limit':
      return setLimit(guild, channel, payload.userLimit, actor);
    case 'lock':
    case 'unlock':
    case 'invisible':
    case 'visible':
    case 'closechat':
    case 'openchat':
      return setPrivacy(guild, channel, op, actor);
    case 'dnd':
      return setDnd(guild, channel, payload.enabled, actor);
    case 'bitrate':
      return setBitrate(guild, channel, payload.bitrate, actor);
    case 'region':
      return setRegion(guild, channel, payload.region, actor);
    case 'delete':
      await deleteChannelByInteraction(channelId, guild, actor);
      return { ok: true };
    case 'transfer':
      return transfer(guild, channel, payload.newOwnerId, actor);
    case 'kick':
      return kickMember(guild, channel, payload.userId, actor);
    default:
      throw new Error(`Unhandled tempvoice op: ${op}`);
  }
}

async function renameChannel(guild, channel, name, actorId) {
  const result = getSafeChannelName(name);
  if (!result.safe) {
    throw new Error(`Name not allowed (${result.reason})`);
  }
  const oldName = channel.name;
  await channel.setName(result.name);
  const ownerId = getOwner(channel.id);
  if (ownerId) await db.updatePresetField(ownerId, guild.id, 'channel_name', result.name).catch(() => null);
  await logEvent(guild, {
    title: 'Channel Renamed',
    actorId,
    channel: { id: channel.id, name: result.name },
    fields: [
      { name: 'Old name', value: `\`${oldName}\``, inline: true },
      { name: 'New name', value: `\`${result.name}\``, inline: true },
      { name: 'Source', value: 'Website', inline: true },
    ],
    kind: 'update',
  });
  db.touchActivity(channel.id).catch(() => null);
  return { ok: true, name: result.name };
}

async function setLimit(guild, channel, userLimit, actorId) {
  const limit = Math.floor(Number(userLimit));
  if (!Number.isFinite(limit) || limit < 0 || limit > 99) {
    throw new Error('User limit must be 0-99');
  }
  await channel.setUserLimit(limit);
  const ownerId = getOwner(channel.id);
  if (ownerId) await db.updatePresetField(ownerId, guild.id, 'user_limit', limit).catch(() => null);
  const display = limit === 0 ? 'unlimited' : `${limit} users`;
  await logEvent(guild, {
    title: 'User Limit Changed',
    actorId,
    channel: { id: channel.id, name: channel.name },
    fields: [
      { name: 'Limit', value: `\`${display}\``, inline: true },
      { name: 'Source', value: 'Website', inline: true },
    ],
    kind: 'update',
  });
  db.touchActivity(channel.id).catch(() => null);
  return { ok: true, userLimit: limit };
}

async function setPrivacy(guild, channel, op, actorId) {
  const patch = everyonePrivacyPatch(op);
  if (!patch) throw new Error(`Invalid privacy op: ${op}`);
  await channel.permissionOverwrites.edit(guild.id, patch);
  const preset = privacyPresetField(op);
  const ownerId = getOwner(channel.id);
  if (ownerId && preset) {
    await db.updatePresetField(ownerId, guild.id, preset.field, preset.value).catch(() => null);
  }
  await logEvent(guild, {
    title: 'Privacy Changed',
    actorId,
    channel: { id: channel.id, name: channel.name },
    fields: [
      { name: 'Setting', value: `\`${op}\``, inline: true },
      { name: 'Source', value: 'Website', inline: true },
    ],
    kind: 'update',
  });
  db.touchActivity(channel.id).catch(() => null);
  return { ok: true, op };
}

async function setDnd(guild, channel, enabled, actorId) {
  const on = Boolean(enabled);
  await channel.permissionOverwrites.edit(guild.id, dndPermissionPatch(on));
  const ownerId = getOwner(channel.id);
  if (ownerId) await db.updatePresetField(ownerId, guild.id, 'is_dnd', on ? 1 : 0).catch(() => null);
  const state = on ? 'enabled' : 'disabled';
  await logEvent(guild, {
    title: 'DND Toggled',
    actorId,
    channel: { id: channel.id, name: channel.name },
    fields: [
      { name: 'State', value: `\`${state}\``, inline: true },
      { name: 'Source', value: 'Website', inline: true },
    ],
    kind: 'update',
  });
  db.touchActivity(channel.id).catch(() => null);
  return { ok: true, enabled: on };
}

async function setBitrate(guild, channel, bitrate, actorId) {
  const n = Math.floor(Number(bitrate));
  if (!BITRATES.has(n)) throw new Error('Unsupported bitrate');
  await channel.setBitrate(n);
  const ownerId = getOwner(channel.id);
  if (ownerId) await db.updatePresetField(ownerId, guild.id, 'bitrate', n).catch(() => null);
  await logEvent(guild, {
    title: 'Bitrate Changed',
    actorId,
    channel: { id: channel.id, name: channel.name },
    fields: [
      { name: 'Bitrate', value: `\`${n / 1000} kbps\``, inline: true },
      { name: 'Source', value: 'Website', inline: true },
    ],
    kind: 'update',
  });
  db.touchActivity(channel.id).catch(() => null);
  return { ok: true, bitrate: n };
}

async function setRegion(guild, channel, region, actorId) {
  const value = region === null || region === undefined ? 'auto' : String(region);
  if (!REGIONS.has(value)) throw new Error('Unsupported region');
  await channel.setRTCRegion(value === 'auto' ? null : value);
  const ownerId = getOwner(channel.id);
  if (ownerId) await db.updatePresetField(ownerId, guild.id, 'region', value).catch(() => null);
  await logEvent(guild, {
    title: 'Region Changed',
    actorId,
    channel: { id: channel.id, name: channel.name },
    fields: [
      { name: 'Region', value: `\`${value}\``, inline: true },
      { name: 'Source', value: 'Website', inline: true },
    ],
    kind: 'update',
  });
  db.touchActivity(channel.id).catch(() => null);
  return { ok: true, region: value };
}

async function transfer(guild, channel, newOwnerId, actorId) {
  if (!snowflake(newOwnerId)) throw new Error('newOwnerId must be a Discord snowflake');
  const ok = await transferOwnership(channel.id, newOwnerId, guild);
  if (!ok) throw new Error('Transfer failed (quota or missing channel)');
  await snapshotChannel(channel).catch(() => null);
  log.info({ channelId: channel.id, newOwnerId, actorId }, 'Staff transferred temp channel');
  return { ok: true, newOwnerId };
}

async function kickMember(guild, channel, userId, actorId) {
  if (!snowflake(userId)) throw new Error('userId must be a Discord snowflake');
  const member = channel.members.get(userId);
  if (!member) throw new Error('That user is not in the channel');
  await member.voice.disconnect('Kicked from temp channel (website)').catch(() => null);
  await logEvent(guild, {
    title: 'User Kicked',
    actorId,
    channel: { id: channel.id, name: channel.name },
    fields: [
      { name: 'Target', value: `<@${userId}> \`${userId}\``, inline: false },
      { name: 'Source', value: 'Website', inline: true },
    ],
    kind: 'destroy',
  });
  db.touchActivity(channel.id).catch(() => null);
  await snapshotChannel(channel).catch(() => null);
  return { ok: true, userId };
}

export async function applyConfigUpdate(payload) {
  const current = await db.getConfig();
  if (!current) throw new Error('Temp voice config row missing');

  const trigger = payload.triggerChannelId !== undefined ? payload.triggerChannelId : current.trigger_channel_id;
  const category = payload.categoryId !== undefined ? payload.categoryId : current.category_id;
  const logChannel = payload.logChannelId !== undefined ? payload.logChannelId : current.log_channel_id;

  if (trigger != null && trigger !== '' && !snowflake(String(trigger))) {
    throw new Error('triggerChannelId must be a Discord snowflake');
  }
  if (category != null && category !== '' && !snowflake(String(category))) {
    throw new Error('categoryId must be a Discord snowflake');
  }
  if (logChannel != null && logChannel !== '' && !snowflake(String(logChannel))) {
    throw new Error('logChannelId must be a Discord snowflake');
  }

  await db.saveConfig(trigger || null, category || null, logChannel || null);

  if (payload.defaultAllowVad !== undefined) {
    await db.setDefaultAllowVad(Boolean(payload.defaultAllowVad));
  }
  if (payload.maxChannelsPerUser !== undefined) {
    await db.setMaxChannelsPerUser(payload.maxChannelsPerUser);
  }

  await loadConfig();
  log.info({ payload }, 'Temp voice config reloaded from website');
  return { ok: true };
}
