import { describe, test, expect, mock, beforeEach } from 'bun:test';

const calls = [];
let queryImpl = () => Promise.resolve([]);

mock.module('../../database/connection.js', () => ({
  query: (...args) => {
    calls.push(args);
    return queryImpl(...args);
  },
  getPool: () => ({}),
}));
mock.module('../../utils/id.js', () => ({ generateId: () => 'generated-id' }));
mock.module('../../logger.js', () => ({
  default: { child: () => ({ warn() {}, info() {}, error() {} }) },
}));

const {
  parseProspectDateOfBirth,
  parseProspectSteamId,
  applyProspectProfile,
} = await import('../userService.js');

beforeEach(() => {
  calls.length = 0;
  queryImpl = () => Promise.resolve([]);
});

describe('parseProspectDateOfBirth', () => {
  test('parses DD-MM-YYYY as UTC', () => {
    expect(parseProspectDateOfBirth('15-03-1994').toISOString().slice(0, 10)).toBe('1994-03-15');
  });
});

describe('parseProspectSteamId', () => {
  test('rejects placeholder Q', () => {
    expect(parseProspectSteamId('Q')).toBeNull();
  });
});

describe('applyProspectProfile', () => {
  const prospect = {
    nationality: 'norway',
    date_of_birth: '15-03-1994',
    steam_id: '76561198000000001',
    status: 'accepted',
    closed_at: new Date('2026-08-20T12:00:00.000Z'),
  };

  test('updates only empty fields on an existing user', async () => {
    queryImpl = (sql) => {
      if (sql.startsWith('SELECT')) {
        return Promise.resolve([{
          id: 'u1',
          country: null,
          dateOfBirth: null,
          membershipDate: null,
          steamId: '76561198000000001',
        }]);
      }
      return Promise.resolve({ affectedRows: 1 });
    };

    await applyProspectProfile('disc-1', prospect, { discordName: 'Nick' });

    const update = calls.find((c) => String(c[0]).startsWith('UPDATE'));
    expect(update).toBeTruthy();
    expect(update[0]).toContain('country = ?');
    expect(update[0]).toContain('dateOfBirth = ?');
    expect(update[0]).toContain('membershipDate = ?');
    expect(update[0]).not.toContain('steamId = ?');
    expect(update[1]).toContain('Norway');
    expect(update[1]).toContain('1994-03-15 00:00:00');
    expect(update[1].at(-1)).toBe('disc-1');
  });

  test('inserts a website user when none exists', async () => {
    queryImpl = (sql) => {
      if (sql.startsWith('SELECT')) return Promise.resolve([]);
      return Promise.resolve({ affectedRows: 1 });
    };

    await applyProspectProfile('disc-1', prospect, { discordName: 'Nick' });

    const insert = calls.find((c) => String(c[0]).startsWith('INSERT'));
    expect(insert).toBeTruthy();
    expect(insert[1]).toEqual([
      'generated-id',
      'disc-1',
      'Nick',
      'Norway',
      '1994-03-15 00:00:00',
      '2026-08-20 12:00:00',
      '76561198000000001',
    ]);
  });

  test('does not write membershipDate for an open application', async () => {
    queryImpl = (sql) => {
      if (sql.startsWith('SELECT')) {
        return Promise.resolve([{
          id: 'u1',
          country: null,
          dateOfBirth: null,
          membershipDate: null,
          steamId: null,
        }]);
      }
      return Promise.resolve({ affectedRows: 1 });
    };

    await applyProspectProfile('disc-1', { ...prospect, status: 'open', closed_at: null });

    const update = calls.find((c) => String(c[0]).startsWith('UPDATE'));
    expect(update[0]).not.toContain('membershipDate');
    expect(update[0]).toContain('country = ?');
  });
});
