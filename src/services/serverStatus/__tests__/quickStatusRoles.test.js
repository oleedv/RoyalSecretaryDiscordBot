import { describe, expect, test } from 'bun:test';
import {
  ADMIN_ROLES,
  classifyOnlinePlayers,
  groupHasKickOrBan,
  isAdminRole,
  pickPrimaryEntry,
} from '../quickStatusRoles.js';

describe('isAdminRole', () => {
  test('matches the five admin titles case-insensitively', () => {
    for (const role of ADMIN_ROLES) {
      expect(isAdminRole(role)).toBe(true);
      expect(isAdminRole(role.toLowerCase())).toBe(true);
      expect(isAdminRole(role.toUpperCase())).toBe(true);
    }
  });

  test('rejects non-admin roles', () => {
    expect(isAdminRole('Member')).toBe(false);
    expect(isAdminRole('Prospect')).toBe(false);
    expect(isAdminRole('Whitelist')).toBe(false);
    expect(isAdminRole('Seeder')).toBe(false);
    expect(isAdminRole('')).toBe(false);
  });

  test('matches spaced variants', () => {
    expect(isAdminRole('Senior Admin')).toBe(true);
    expect(isAdminRole('Trainee Admin')).toBe(true);
  });
});

describe('classifyOnlinePlayers', () => {
  test('counts roles and lists admins with team', () => {
    const players = [
      { steamID: '1', name: 'Alice', teamID: 1 },
      { steamID: '2', name: 'Bob', teamID: 2 },
      { steamID: '3', name: 'Carol', teamID: 1 },
      { steamID: '4', name: 'Dave', teamID: 2 },
      { steamID: '5', name: 'Eve', teamID: 1 },
      { steamID: '6', name: 'Public', teamID: 1 },
    ];
    const map = new Map([
      ['1', [{ role: 'Member', name: 'Alice' }]],
      ['2', [{ role: 'Member', name: 'Bob' }]],
      ['3', [{ role: 'Prospect', name: 'Carol' }]],
      ['4', [{ role: 'Whitelist', name: 'Dave' }]],
      ['5', [{ role: 'SuperAdmin', name: 'Eve' }]],
    ]);

    const r = classifyOnlinePlayers(players, map);
    expect(r.rbCount).toBe(2);
    expect(r.teamOneRBs).toBe(1);
    expect(r.teamTwoRBs).toBe(1);
    expect(r.prospectCount).toBe(1);
    expect(r.wlCount).toBe(1);
    expect(r.adminCount).toBe(1);
    expect(r.teamOneSize).toBe(4);
    expect(r.teamTwoSize).toBe(2);
    expect(r.adminsOnline).toEqual([
      { name: 'Eve', role: 'SuperAdmin', teamID: 1 },
    ]);
  });

  test('Member + Admin stacks both counts and lists admin', () => {
    const players = [{ steamID: '9', name: 'FounderJoe', teamID: 2 }];
    const map = new Map([
      ['9', [
        { role: 'Member', name: 'FounderJoe' },
        { role: 'Founder', name: 'FounderJoe' },
      ]],
    ]);
    const r = classifyOnlinePlayers(players, map);
    expect(r.adminCount).toBe(1);
    expect(r.rbCount).toBe(1);
    expect(r.teamTwoRBs).toBe(1);
    expect(r.adminsOnline[0].role).toBe('Founder');
  });

  test('admin role preference picks highest title', () => {
    const players = [{ steamID: '1', name: 'Boss', teamID: 1 }];
    const map = new Map([
      ['1', [
        { role: 'TraineeAdmin' },
        { role: 'SeniorAdmin' },
      ]],
    ]);
    const r = classifyOnlinePlayers(players, map);
    expect(r.adminsOnline[0].role).toBe('SeniorAdmin');
  });

  test('AdminGroup.name counts as admin even when role is Member', () => {
    const players = [{ steamID: '1', name: 'Bonnie', teamID: 1 }];
    const map = new Map([
      ['1', [{ role: 'Member', groupName: 'SuperAdmin', name: 'Bonnie' }]],
    ]);
    const r = classifyOnlinePlayers(players, map);
    expect(r.adminCount).toBe(1);
    expect(r.rbCount).toBe(1);
    expect(r.wlCount).toBe(0);
    expect(r.adminsOnline).toEqual([
      { name: 'Bonnie', role: 'SuperAdmin', teamID: 1 },
    ]);
  });

  test('AdminGroup.name counts as admin when role is Whitelist', () => {
    const players = [{ steamID: '2', name: 'Lind', teamID: 2 }];
    const map = new Map([
      ['2', [{ role: 'Whitelist', groupName: 'Admin', name: 'Lind' }]],
    ]);
    const r = classifyOnlinePlayers(players, map);
    expect(r.adminCount).toBe(1);
    expect(r.wlCount).toBe(0);
    expect(r.adminsOnline[0]).toEqual({ name: 'Lind', role: 'Admin', teamID: 2 });
  });

  test('groupName-only row with no role string is still classified', () => {
    const players = [{ steamID: '3', name: 'Solo', teamID: 1 }];
    const map = new Map([
      ['3', [{ role: null, groupName: 'Founder', name: 'Solo' }]],
    ]);
    const r = classifyOnlinePlayers(players, map);
    expect(r.adminCount).toBe(1);
    expect(r.adminsOnline[0].role).toBe('Founder');
  });

  test('any group with kick or ban permissions is an admin', () => {
    const players = [{ steamID: '1', name: 'Pat', teamID: 1 }];
    const map = new Map([
      ['1', [{
        role: 'Member',
        groupName: 'ServerStaff',
        groupPermissions: 'chat,kick,canseeadminchat',
        name: 'Pat',
      }]],
    ]);
    const r = classifyOnlinePlayers(players, map);
    expect(r.adminCount).toBe(1);
    expect(r.rbCount).toBe(1);
    expect(r.adminsOnline[0]).toEqual({ name: 'Pat', role: 'ServerStaff', teamID: 1 });
  });

  test('group without kick or ban is not an admin even if named Admin', () => {
    const players = [{ steamID: '1', name: 'Cam', teamID: 2 }];
    const map = new Map([
      ['1', [{
        role: 'Admin',
        groupName: 'Admin',
        groupPermissions: 'cameraman,chat,reserve',
        name: 'Cam',
      }]],
    ]);
    const r = classifyOnlinePlayers(players, map);
    expect(r.adminCount).toBe(0);
    expect(r.adminsOnline).toEqual([]);
  });

  test('role string matching a kick/ban group name counts when groupId is missing', () => {
    const players = [{ steamID: '1', name: 'Lee', teamID: 1 }];
    const map = new Map([
      ['1', [{ role: 'Mod', name: 'Lee' }]],
    ]);
    const groups = [
      { name: 'Mod', permissions: 'kick,ban', sortOrder: 3 },
      { name: 'Whitelist', permissions: 'reserve,chat', sortOrder: 10 },
    ];
    const r = classifyOnlinePlayers(players, map, groups);
    expect(r.adminCount).toBe(1);
    expect(r.adminsOnline[0].role).toBe('Mod');
  });
});

describe('groupHasKickOrBan', () => {
  test('true when kick or ban is present', () => {
    expect(groupHasKickOrBan('kick')).toBe(true);
    expect(groupHasKickOrBan('ban')).toBe(true);
    expect(groupHasKickOrBan('chat,kick,ban')).toBe(true);
    expect(groupHasKickOrBan('BAN,changemap')).toBe(true);
    expect(groupHasKickOrBan(' kick , reserve ')).toBe(true);
  });

  test('false without kick or ban', () => {
    expect(groupHasKickOrBan('')).toBe(false);
    expect(groupHasKickOrBan(null)).toBe(false);
    expect(groupHasKickOrBan('cameraman,chat,reserve')).toBe(false);
    expect(groupHasKickOrBan('kickvote')).toBe(false);
  });
});

describe('pickPrimaryEntry', () => {
  test('prefers admin over member', () => {
    const primary = pickPrimaryEntry([
      { role: 'Member' },
      { role: 'Admin' },
    ]);
    expect(primary.role).toBe('Admin');
  });
});
