import { describe, test, expect, mock, beforeEach } from 'bun:test';

// Mock the DB + collaborators so createEntry can be tested without a live MariaDB.
let queryImpl = () => Promise.resolve([]);
const calls = [];
mock.module('../../database/connection.js', () => ({
  query: (...args) => {
    calls.push(args);
    return queryImpl(...args);
  },
  getPool: () => ({}), // website pool "configured"
}));
mock.module('../../utils/id.js', () => ({ generateId: () => 'generated-id' }));
mock.module('../whitelistAudit.js', () => ({ logWhitelistActivity: () => Promise.resolve() }));
mock.module('../../logger.js', () => ({
  default: { child: () => ({ warn() {}, info() {}, error() {} }) },
}));

const { createEntry, createSlEntry } = await import('../whitelistService.js');

// route each query by its SQL: link-id lookups + existing-entry check vs writes
function route(existingRows) {
  return (sql) => {
    if (sql.startsWith('INSERT') || sql.startsWith('UPDATE')) return Promise.resolve({ affectedRows: 1 });
    if (sql.includes('WhitelistEntry WHERE steamId')) return Promise.resolve(existingRows);
    return Promise.resolve([]); // Clan / AdminGroup link lookups
  };
}

beforeEach(() => {
  calls.length = 0;
  queryImpl = () => Promise.resolve([]);
});

describe('createEntry', () => {
  test('INSERTs a new row when the player has no existing main entry', async () => {
    queryImpl = route([]); // no existing (steamId,'main') row
    const res = await createEntry('76561198000000001', 'Alice', 'RB', 'Prospect', 'actor');

    expect(res).not.toBeNull();
    const sqls = calls.map((c) => c[0]);
    expect(sqls.some((s) => s.startsWith('INSERT INTO WhitelistEntry'))).toBe(true);
    expect(sqls.some((s) => s.startsWith('UPDATE WhitelistEntry'))).toBe(false);
  });

  test('UPDATEs in place (no duplicate INSERT) when a main entry already exists', async () => {
    // Regression: a blind INSERT here threw ER_DUP_ENTRY on the (steamId, server) unique key
    // when the player already had a (commonly expired) 'main' entry — silently failing the add.
    queryImpl = route([{ id: 'existing-id' }]);
    const res = await createEntry('76561198819769429', 'Lind', 'RB', 'Prospect', 'actor');

    expect(res).toEqual(expect.objectContaining({ id: 'existing-id', role: 'Prospect' }));
    const sqls = calls.map((c) => c[0]);
    expect(sqls.some((s) => s.startsWith('UPDATE WhitelistEntry'))).toBe(true);
    expect(sqls.some((s) => s.startsWith('INSERT INTO WhitelistEntry'))).toBe(false);
  });
});

describe('createSlEntry', () => {
  test('revives an existing (incl. expired) main row instead of a duplicate INSERT', async () => {
    // Regression: eligibility's findEntries() hides expired rows, so an expired player is judged
    // first_grant and createSlEntry blind-INSERTed -> ER_DUP_ENTRY on the expired row every run.
    queryImpl = route([{ id: 'expired-id' }]);
    const res = await createSlEntry('76561198819769429', 'user1', 'Lind', 'clan1', 'sl-reward-system', 'first_grant', 30);

    expect(res).toEqual(expect.objectContaining({ id: 'expired-id' }));
    const sqls = calls.map((c) => c[0]);
    expect(sqls.some((s) => s.trim().startsWith('UPDATE WhitelistEntry'))).toBe(true);
    expect(sqls.some((s) => s.includes('INSERT INTO WhitelistEntry'))).toBe(false);
  });

  test('INSERTs when the player has no existing main row', async () => {
    queryImpl = route([]);
    const res = await createSlEntry('76561190000000009', 'user2', 'New', 'clan1', 'sl-reward-system', 'first_grant', 30);

    expect(res).not.toBeNull();
    const sqls = calls.map((c) => c[0]);
    expect(sqls.some((s) => s.includes('INSERT INTO WhitelistEntry'))).toBe(true);
  });
});
