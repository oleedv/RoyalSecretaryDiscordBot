import { describe, expect, test } from 'bun:test';
import { buildQuickStatusEmbed } from '../quickStatusEmbeds.js';

function baseState(overrides = {}) {
  return {
    connected: true,
    playerCount: 78,
    publicSlots: 80,
    reserveSlots: 20,
    publicQueue: 4,
    reserveQueue: 0,
    serverName: 'Royal Battalion One | MAIN',
    currentLayer: 'Mutaha_RAAS_v1',
    gameVersion: 'v8.2.1.12345',
    currentLayerObj: {
      teams: [
        { shortName: 'USA', name: 'US Army', faction: 'USA' },
        { shortName: 'RGF', name: 'Russian Ground Forces', faction: 'RGF' },
      ],
    },
    players: [],
    ...overrides,
  };
}

describe('buildQuickStatusEmbed', () => {
  test('builds a live embed with role breakdown and admins', () => {
    const roles = {
      rbCount: 12,
      prospectCount: 3,
      wlCount: 8,
      adminCount: 2,
      teamOneRBs: 7,
      teamTwoRBs: 5,
      teamOneSize: 39,
      teamTwoSize: 39,
      adminsOnline: [
        { name: 'Bonnie', role: 'SuperAdmin', teamID: 1 },
        { name: 'Lind', role: 'Admin', teamID: 2 },
      ],
    };
    const stats = {
      matchStartTime: Math.floor(Date.now() / 1000) - 4320,
      avgTps: 48.2,
      minTps: 45,
      maxTps: 50,
      newPlayers1h: 6,
    };

    const embed = buildQuickStatusEmbed(baseState(), 40, roles, stats);
    const data = embed.toJSON();

    expect(data.title).toContain('Royal Battalion One | MAIN');
    expect(data.description).toContain('LIVE');
    expect(data.fields.some((f) => f.name === 'Online' && f.value.includes('78'))).toBe(true);
    expect(data.fields.some((f) => f.name === 'RB Members' && f.value.includes('12') && f.value.includes('7v5'))).toBe(true);
    expect(data.fields.some((f) => f.name === 'WL / Admins' && f.value.includes('8') && f.value.includes('2'))).toBe(true);
    expect(data.fields.some((f) => f.name.startsWith('Admins online') && f.value.includes('Bonnie'))).toBe(true);
    expect(data.fields.some((f) => f.name.startsWith('Admins online') && f.value.includes('Lind'))).toBe(true);
    // No full roster fields
    expect(data.fields.every((f) => !f.name.startsWith('Team 1 •'))).toBe(true);
  });

  test('seeding state when below threshold', () => {
    const embed = buildQuickStatusEmbed(
      baseState({ playerCount: 23, publicQueue: 0 }),
      40,
      { adminsOnline: [] },
      {}
    );
    expect(embed.toJSON().description).toContain('seeding');
  });

  test('shows none online when admin list empty', () => {
    const embed = buildQuickStatusEmbed(baseState({ playerCount: 0 }), 40, {
      adminsOnline: [],
      teamOneSize: 0,
      teamTwoSize: 0,
    }, {});
    const adminField = embed.toJSON().fields.find((f) => f.name.startsWith('Admins online'));
    expect(adminField.value).toContain('None online');
  });
});
