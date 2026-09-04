import { describe, it, expect } from 'bun:test';
import { PermissionFlagsBits } from 'discord.js';
import {
  eventTypeFromTitle,
  inspectChannel,
  everyonePrivacyPatch,
  dndPermissionPatch,
  privacyPresetField,
  MANAGE_OPS,
} from './tempvoiceState.js';

function overwrite({ deny = [], allow = [] } = {}) {
  const denySet = new Set(deny);
  const allowSet = new Set(allow);
  return {
    deny: { has: (bit) => denySet.has(bit) },
    allow: { has: (bit) => allowSet.has(bit) },
  };
}

function fakeChannel({ everyoneDeny = [], members = [], overwrites = [] } = {}) {
  const cache = new Map();
  cache.set('guild-1', overwrite({ deny: everyoneDeny }));
  for (const [id, ow] of overwrites) cache.set(id, ow);
  return {
    name: 'OleEd\'s Channel',
    userLimit: 4,
    bitrate: 64000,
    rtcRegion: 'rotterdam',
    guild: { id: 'guild-1', client: { user: { id: 'bot-1' } } },
    permissionOverwrites: { cache },
    members: {
      keys() { return members[Symbol.iterator](); },
    },
  };
}

describe('eventTypeFromTitle', () => {
  it('maps known Discord log titles', () => {
    expect(eventTypeFromTitle('Channel Created')).toBe('created');
    expect(eventTypeFromTitle('Channel Deleted')).toBe('deleted');
    expect(eventTypeFromTitle('Privacy Changed')).toBe('privacy');
    expect(eventTypeFromTitle('Blocked Channel Name')).toBe('blocked_name');
  });

  it('falls back to other', () => {
    expect(eventTypeFromTitle('Something new')).toBe('other');
  });
});

describe('inspectChannel', () => {
  it('reads empty unlocked channel', () => {
    const snap = inspectChannel(fakeChannel(), 'owner-1');
    expect(snap.channelName).toBe("OleEd's Channel");
    expect(snap.userLimit).toBe(4);
    expect(snap.bitrate).toBe(64000);
    expect(snap.region).toBe('rotterdam');
    expect(snap.isLocked).toBe(0);
    expect(snap.isInvisible).toBe(0);
    expect(snap.isChatClosed).toBe(0);
    expect(snap.isDnd).toBe(0);
    expect(snap.memberCount).toBe(0);
    expect(snap.memberIds).toEqual([]);
  });

  it('reads privacy flags and occupancy, skipping bot and owner in trust/block lists', () => {
    const snap = inspectChannel(fakeChannel({
      everyoneDeny: [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak],
      members: ['owner-1', 'user-2', 'bot-1'],
      overwrites: [
        ['owner-1', overwrite({ allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel] })],
        ['trusted-1', overwrite({ allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel] })],
        ['blocked-1', overwrite({ deny: [PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel] })],
      ],
    }), 'owner-1');

    expect(snap.isLocked).toBe(1);
    expect(snap.isDnd).toBe(1);
    expect(snap.memberIds).toEqual(['owner-1', 'user-2']);
    expect(snap.memberCount).toBe(2);
    expect(snap.trustedIds).toEqual(['trusted-1']);
    expect(snap.blockedIds).toEqual(['blocked-1']);
  });
});

describe('privacy helpers', () => {
  it('maps ops to overwrite patches and preset fields', () => {
    expect(everyonePrivacyPatch('lock')).toEqual({ Connect: false });
    expect(everyonePrivacyPatch('openchat')).toEqual({ SendMessages: true });
    expect(everyonePrivacyPatch('nope')).toBeNull();
    expect(privacyPresetField('invisible')).toEqual({ field: 'is_invisible', value: 1 });
    expect(privacyPresetField('unlock')).toEqual({ field: 'is_locked', value: 0 });
  });

  it('builds DND permission patches', () => {
    expect(dndPermissionPatch(true).Speak).toBe(false);
    expect(dndPermissionPatch(false).Speak).toBeNull();
  });

  it('includes the staff ops the website can queue', () => {
    for (const op of ['rename', 'lock', 'delete', 'kick', 'transfer', 'dnd']) {
      expect(MANAGE_OPS.has(op)).toBe(true);
    }
  });
});
