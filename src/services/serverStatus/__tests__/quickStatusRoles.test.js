import { describe, expect, test } from 'bun:test';
import {
  ADMIN_ROLES,
  classifyOnlinePlayers,
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
