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
  // Run the callback with a conn whose query routes through the same impl, so
  // transactional writes are observable in `calls` just like pooled ones.
  transaction: (fn) => fn({
    query: (...args) => {
      calls.push(args);
      return queryImpl(...args);
    },
  }),
}));
mock.module('../../utils/id.js', () => ({ generateId: () => 'generated-id' }));
const auditCalls = [];
mock.module('../whitelistAudit.js', () => ({
  logWhitelistActivity: (...args) => {
    auditCalls.push(args);
    return Promise.resolve();
  },
}));
const reportErrorCalls = [];
mock.module('../admin/errorAlertService.js', () => ({
  reportError: (...args) => { reportErrorCalls.push(args); return Promise.resolve(); },
}));
mock.module('../../logger.js', () => ({
  default: { child: () => ({ warn() {}, info() {}, error() {} }) },
}));

const { createEntry, createSlEntry, expireByRole, upsertSeederEntry, promoteToMember, extendEntryByDays } = await import('../whitelistService.js');

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
  auditCalls.length = 0;
  reportErrorCalls.length = 0;
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

describe('upsertSeederEntry stamps the "Monthly seeders" clan', () => {
  // Route link lookups to concrete ids so we can assert clanId is resolved+written,
  // not just the fallback string. Clan tag lookup -> the Monthly seeders clan id.
  function seederRoute(existingRows) {
    return (sql) => {
      if (sql.startsWith('INSERT') || sql.startsWith('UPDATE')) return Promise.resolve({ affectedRows: 1 });
      if (sql.includes('WhitelistEntry WHERE steamId')) return Promise.resolve(existingRows);
      if (sql.includes('FROM Clan WHERE tag')) return Promise.resolve([{ id: 'clan-monthly-seeders' }]);
      if (sql.includes('FROM AdminGroup WHERE name')) return Promise.resolve([{ id: 'group-seeder' }]);
      return Promise.resolve([]);
    };
  }

  test('INSERT path sets clan + resolved clanId for a first-time grant', async () => {
    queryImpl = seederRoute([]); // no existing (steamId,'main') row
    await upsertSeederEntry('76561198000000010', 'Seedy', new Date('2026-08-01T00:00:00Z'));

    const insert = calls.find((c) => String(c[0]).startsWith('INSERT INTO WhitelistEntry'));
    expect(insert).toBeDefined();
    expect(String(insert[0])).toContain('clan, clanId');
    expect(insert[1]).toContain('Monthly seeders');
    expect(insert[1]).toContain('clan-monthly-seeders');
  });

  test('UPDATE path sets clan + resolved clanId when renewing an existing entry', async () => {
    queryImpl = seederRoute([{ id: 'existing-seeder', role: 'Seeder', expiresAt: null }]);
    await upsertSeederEntry('76561198000000011', 'Seedy', new Date('2026-08-01T00:00:00Z'));

    const update = calls.find((c) => String(c[0]).startsWith('UPDATE WhitelistEntry'));
    expect(update).toBeDefined();
    expect(String(update[0])).toContain('clan = ?, clanId = ?');
    expect(update[1]).toContain('Monthly seeders');
    expect(update[1]).toContain('clan-monthly-seeders');
  });

  test('UPDATE path logs expiry from/to so activity is not a blank "Updated entry"', async () => {
    queryImpl = seederRoute([{
      id: 'existing-seeder',
      role: 'Seeder',
      expiresAt: '2026-07-01T00:00:00.000Z',
    }]);
    await upsertSeederEntry('76561198000000011', 'Seedy', new Date('2026-08-01T00:00:00Z'));

    expect(auditCalls).toHaveLength(1);
    const [action, resourceId, actor, detail] = auditCalls[0];
    expect(action).toBe('whitelist.update');
    expect(resourceId).toBe('existing-seeder');
    expect(actor).toEqual({ system: 'seedTracker' });
    expect(detail).toEqual({
      steamId: '76561198000000011',
      name: 'Seedy',
      role: 'Seeder',
      clan: 'Monthly seeders',
      source: 'seed-tracker',
      changes: {
        expiresAt: {
          from: '2026-07-01T00:00:00.000Z',
          to: '2026-08-01T00:00:00.000Z',
          extendedByDays: 31,
        },
      },
    });
  });
});

describe('promoteToMember is role-agnostic + idempotent', () => {
  // Regression: an accepted prospect who still held a *Seeder* (or expired/other) whitelist
  // row was promoted via updateRole('Prospect'->'Member'), which matched 0 rows and silently
  // left the stale Seeder group in place. Promotion must convert whatever single (steamId,'main')
  // row exists — Seeder, expired Prospect, Whitelist, anything — into a permanent Member entry.
  function memberRoute(existingRows) {
    return (sql) => {
      if (sql.startsWith('INSERT') || sql.startsWith('UPDATE')) return Promise.resolve({ affectedRows: 1 });
      if (sql.includes('WhitelistEntry WHERE steamId')) return Promise.resolve(existingRows);
      if (sql.includes('FROM Clan WHERE tag')) return Promise.resolve([{ id: 'clan-rb' }]);
      if (sql.includes('FROM AdminGroup WHERE name')) return Promise.resolve([{ id: 'group-member' }]);
      return Promise.resolve([]);
    };
  }

  test('converts an existing Seeder row to a permanent Member entry (not just role="Prospect")', async () => {
    queryImpl = memberRoute([{ id: 'seeder-id', role: 'Seeder' }]);
    const res = await promoteToMember('76561198000000020', 'Recruit', { discordId: 'staff-1' });

    expect(res).toEqual(expect.objectContaining({ id: 'seeder-id', role: 'Member' }));
    const update = calls.find((c) => String(c[0]).startsWith('UPDATE WhitelistEntry'));
    expect(update).toBeDefined();
    expect(String(update[0])).toContain("role = 'Member'");
    expect(String(update[0])).toContain('expiresAt = NULL');
    // Role-agnostic: it keys on the row id, never filters on the current role being 'Prospect'.
    expect(String(update[0])).not.toContain("role = 'Prospect'");
    expect(calls.some((c) => String(c[0]).startsWith('INSERT INTO WhitelistEntry'))).toBe(false);
  });

  test('INSERTs a fresh permanent Member entry when the player has no existing row', async () => {
    queryImpl = memberRoute([]);
    const res = await promoteToMember('76561198000000021', 'FreshBlood', { discordId: 'staff-1' });

    expect(res).toEqual(expect.objectContaining({ role: 'Member' }));
    const insert = calls.find((c) => String(c[0]).startsWith('INSERT INTO WhitelistEntry'));
    expect(insert).toBeDefined();
    expect(String(insert[0])).toContain("'Member'");
    expect(calls.some((c) => String(c[0]).startsWith('UPDATE WhitelistEntry'))).toBe(false);
  });
});

describe('extendEntryByDays', () => {
  test('logs the player name and steamId on an SL reward extension', async () => {
    queryImpl = (sql) => {
      if (sql.includes('SELECT steamId, name FROM WhitelistEntry WHERE id')) {
        return Promise.resolve([{ steamId: '76561198819769429', name: 'Lind' }]);
      }
      if (sql.startsWith('UPDATE')) return Promise.resolve({ affectedRows: 1 });
      return Promise.resolve([]);
    };

    const ok = await extendEntryByDays('entry-1', 7);

    expect(ok).toBe(true);
    expect(auditCalls).toHaveLength(1);
    const [action, resourceId, actor, detail] = auditCalls[0];
    expect(action).toBe('whitelist.update');
    expect(resourceId).toBe('entry-1');
    expect(actor).toEqual({ system: 'slReward' });
    expect(detail).toEqual({
      steamId: '76561198819769429',
      name: 'Lind',
      source: 'sl-reward',
      changes: { expiresAt: { extendedByDays: 7 } },
    });
  });
});

describe('write-failure alerting (M2)', () => {
  test('createEntry alerts via reportError and returns null when the write throws', async () => {
    queryImpl = (sql) => {
      if (sql.startsWith('INSERT') || sql.startsWith('UPDATE')) {
        return Promise.reject(new Error('ER_LOCK_DEADLOCK'));
      }
      return Promise.resolve([]); // no existing row + link lookups
    };

    const res = await createEntry('76561198000000002', 'Bob', 'RB', 'Prospect', 'actor');

    expect(res).toBeNull();
    expect(reportErrorCalls.length).toBe(1);
    expect(reportErrorCalls[0][1]).toEqual(
      expect.objectContaining({ source: 'whitelist:createEntry', severity: 'error' })
    );
  });
});

describe('expireByRole transactional loop (M3)', () => {
  test('expires every matching row and reports the count', async () => {
    queryImpl = (sql) => {
      if (sql.startsWith('SELECT * FROM WhitelistEntry WHERE steamId')) {
        return Promise.resolve([
          { id: 'a', role: 'Seeder' },
          { id: 'b', role: 'Seeder' },
          { id: 'c', role: 'Member' }, // different role — must be left untouched
        ]);
      }
      return Promise.resolve({ affectedRows: 1 });
    };

    const n = await expireByRole('76561198000000003', 'Seeder');

    expect(n).toBe(2);
    const expiries = calls.filter((c) => String(c[0]).startsWith('UPDATE WhitelistEntry SET expiresAt = NOW()'));
    expect(expiries.length).toBe(2);
    expect(reportErrorCalls.length).toBe(0);
  });

  test('rolls up to null + alerts when a row update throws mid-loop', async () => {
    queryImpl = (sql) => {
      if (sql.startsWith('SELECT * FROM WhitelistEntry WHERE steamId')) {
        return Promise.resolve([{ id: 'a', role: 'Seeder' }]);
      }
      if (String(sql).startsWith('UPDATE')) return Promise.reject(new Error('ER_LOCK_WAIT_TIMEOUT'));
      return Promise.resolve([]);
    };

    const res = await expireByRole('76561198000000004', 'Seeder');

    expect(res).toBeNull();
    expect(reportErrorCalls[0][1]).toEqual(
      expect.objectContaining({ source: 'whitelist:expireByRole', severity: 'error' })
    );
  });
});
