import { describe, test, expect, mock, beforeEach } from 'bun:test';

// Mock the DB layer so the service can be tested without a live MariaDB.
let queryImpl = () => Promise.resolve([]);
const calls = [];
mock.module('../../../database/connection.js', () => ({
  query: (...args) => {
    calls.push(args);
    return queryImpl(...args);
  },
}));

const { getUserTimezone, setUserTimezone, clearUserTimezone } = await import('../timestampService.js');

beforeEach(() => {
  calls.length = 0;
  queryImpl = () => Promise.resolve([]);
});

describe('getUserTimezone', () => {
  test('returns the stored zone for a known user', async () => {
    queryImpl = () => Promise.resolve([{ timezone: 'Europe/Oslo' }]);
    const tz = await getUserTimezone('123');
    expect(tz).toBe('Europe/Oslo');

    const [sql, params] = calls[0];
    expect(sql).toContain('SELECT');
    expect(sql).toContain('user_timezone');
    expect(params).toEqual(['123']);
  });

  test('returns null when the user has no saved zone', async () => {
    queryImpl = () => Promise.resolve([]);
    expect(await getUserTimezone('123')).toBeNull();
  });
});

describe('setUserTimezone', () => {
  test('upserts the zone', async () => {
    await setUserTimezone('123', 'America/New_York');
    const [sql, params] = calls[0];
    expect(sql).toContain('INSERT INTO user_timezone');
    expect(sql.toUpperCase()).toContain('ON DUPLICATE KEY UPDATE');
    expect(params).toEqual(['123', 'America/New_York']);
  });
});

describe('clearUserTimezone', () => {
  test('deletes the row', async () => {
    await clearUserTimezone('123');
    const [sql, params] = calls[0];
    expect(sql).toContain('DELETE');
    expect(sql).toContain('user_timezone');
    expect(params).toEqual(['123']);
  });
});
