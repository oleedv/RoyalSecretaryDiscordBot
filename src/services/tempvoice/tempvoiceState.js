import { PermissionFlagsBits } from 'discord.js';

export const EVENT_TYPES_BY_TITLE = {
  'Channel Created': 'created',
  'Channel Deleted': 'deleted',
  'Channel Renamed': 'renamed',
  'Privacy Changed': 'privacy',
  'DND Toggled': 'dnd',
  'Region Changed': 'region',
  'Bitrate Changed': 'bitrate',
  'User Limit Changed': 'limit',
  'User Trusted': 'trust',
  'User Untrusted': 'untrust',
  'User Blocked': 'block',
  'User Unblocked': 'unblock',
  'Invite Sent': 'invite',
  'User Kicked': 'kick',
  'Ownership Transferred': 'transfer',
  'Channel Claimed': 'claim',
  'Blocked Channel Name': 'blocked_name',
  'Config Updated': 'config',
};

export function eventTypeFromTitle(title) {
  return EVENT_TYPES_BY_TITLE[title] || 'other';
}

export const PRIVACY_OPS = new Set(['lock', 'unlock', 'invisible', 'visible', 'closechat', 'openchat']);

export const MANAGE_OPS = new Set([
  'rename', 'limit', 'lock', 'unlock', 'invisible', 'visible',
  'closechat', 'openchat', 'dnd', 'bitrate', 'region',
  'delete', 'transfer', 'kick',
]);

export const BITRATES = new Set([32000, 48000, 64000, 80000, 96000, 128000, 256000, 384000]);

export const REGIONS = new Set([
  'auto', 'us-east', 'us-west', 'us-central', 'us-south', 'brazil',
  'singapore', 'sydney', 'russia', 'south-africa', 'hongkong',
  'india', 'japan', 'rotterdam', 'south-korea',
]);

/**
 * Read live Discord channel state into a plain snapshot for DB / the website.
 * `overwrites` is discord.js Collection-like: .cache.get(id) / .cache iterable of [id, overwrite].
 */
export function inspectChannel(channel, ownerId = null) {
  const guildId = channel.guild?.id;
  const botId = channel.guild?.client?.user?.id;
  const everyone = guildId ? channel.permissionOverwrites?.cache?.get(guildId) : null;

  const denyHas = (bit) => Boolean(everyone?.deny?.has(bit));

  const memberIds = [];
  if (channel.members) {
    for (const id of channel.members.keys()) {
      if (id !== botId) memberIds.push(id);
    }
  }

  const trustedIds = [];
  const blockedIds = [];
  const cache = channel.permissionOverwrites?.cache;
  if (cache) {
    for (const [id, ow] of cache) {
      if (id === guildId || id === botId || id === ownerId) continue;
      const denyConnect = ow.deny?.has(PermissionFlagsBits.Connect);
      const denyView = ow.deny?.has(PermissionFlagsBits.ViewChannel);
      const allowConnect = ow.allow?.has(PermissionFlagsBits.Connect);
      const allowView = ow.allow?.has(PermissionFlagsBits.ViewChannel);
      if (denyConnect && denyView) blockedIds.push(id);
      else if (allowConnect && allowView) trustedIds.push(id);
    }
  }

  return {
    channelName: channel.name || 'Unknown',
    userLimit: Number(channel.userLimit) || 0,
    bitrate: channel.bitrate != null ? Number(channel.bitrate) : null,
    region: channel.rtcRegion || 'auto',
    isLocked: denyHas(PermissionFlagsBits.Connect) ? 1 : 0,
    isInvisible: denyHas(PermissionFlagsBits.ViewChannel) ? 1 : 0,
    isChatClosed: denyHas(PermissionFlagsBits.SendMessages) ? 1 : 0,
    isDnd: denyHas(PermissionFlagsBits.Speak) ? 1 : 0,
    memberCount: memberIds.length,
    memberIds,
    trustedIds,
    blockedIds,
  };
}

export function everyonePrivacyPatch(op) {
  switch (op) {
    case 'lock': return { Connect: false };
    case 'unlock': return { Connect: true };
    case 'invisible': return { ViewChannel: false };
    case 'visible': return { ViewChannel: true };
    case 'closechat': return { SendMessages: false };
    case 'openchat': return { SendMessages: true };
    default: return null;
  }
}

export function dndPermissionPatch(enabled) {
  if (enabled) {
    return {
      Speak: false,
      Stream: false,
      UseVAD: false,
      PrioritySpeaker: false,
      UseSoundboard: false,
      UseEmbeddedActivities: false,
    };
  }
  return {
    Speak: null,
    Stream: null,
    UseVAD: null,
    PrioritySpeaker: null,
    UseSoundboard: null,
    UseEmbeddedActivities: null,
  };
}

export function privacyPresetField(op) {
  switch (op) {
    case 'lock': return { field: 'is_locked', value: 1 };
    case 'unlock': return { field: 'is_locked', value: 0 };
    case 'invisible': return { field: 'is_invisible', value: 1 };
    case 'visible': return { field: 'is_invisible', value: 0 };
    case 'closechat': return { field: 'is_chat_closed', value: 1 };
    case 'openchat': return { field: 'is_chat_closed', value: 0 };
    default: return null;
  }
}
