import { test, expect } from 'bun:test';
import { buildCandidateReport } from './report.js';

const META = {
  nowIso: '2026-06-17T14:30:00Z',
  env: 'production',
  dry: false,
  thresholdHours: 5,
  rewardDays: 7,
  candidates: 4,
  grants: 1,
  extensions: 1,
  skipped: 2,
  dmsQueued: 0,
  dmsRedelivered: 1
};

const ROWS = [
  { name: 'PlayerThree', steamId: '76561190000000003', hours: 8.0, action: 'skip', reason: 'has_other_whitelist', discordId: null },
  { name: 'PlayerOne', steamId: '76561190000000001', hours: 6.3, action: 'grant', reason: 'first_grant', discordId: '111' },
  { name: 'PlayerFour', steamId: '76561190000000004', hours: 5.5, action: 'skip', reason: 'still_active', discordId: null },
  { name: 'PlayerTwo', steamId: '76561190000000002', hours: 5.1, action: 'extend', reason: 'near_expiry', discordId: '222' }
];

test('report header carries run metadata and counts', () => {
  const out = buildCandidateReport(ROWS, META);
  expect(out).toContain('SL Grant Cron Run: 2026-06-17 14:30 UTC');
  expect(out).toContain('Environment: production | Dry-run: no');
  expect(out).toContain('Threshold: 5.0h rolling 7d | Reward: 7 days');
  expect(out).toContain('Candidates: 4 | Granted: 1 | Extended: 1 | Skipped: 2 | DMs: queued 0 · redelivered 1');
});

test('report lists rows ordered grant, extend, then skip (hours desc within group)', () => {
  const out = buildCandidateReport(ROWS, META);
  const iOne = out.indexOf('PlayerOne'); // grant
  const iTwo = out.indexOf('PlayerTwo'); // extend
  const iThree = out.indexOf('PlayerThree'); // skip 8.0h
  const iFour = out.indexOf('PlayerFour'); // skip 5.5h
  expect(iOne).toBeGreaterThan(-1);
  expect(iOne).toBeLessThan(iTwo);
  expect(iTwo).toBeLessThan(iThree);
  expect(iThree).toBeLessThan(iFour); // 8.0 before 5.5 within skips
});

test('report shows action, reason, steam id and discord (dash when unknown)', () => {
  const out = buildCandidateReport(ROWS, META);
  expect(out).toContain('GRANT');
  expect(out).toContain('EXTEND');
  expect(out).toContain('SKIP');
  expect(out).toContain('first_grant');
  expect(out).toContain('76561190000000001');
  expect(out).toContain('111'); // discord for granted player
  const skipLine = out.split('\n').find((l) => l.includes('PlayerThree'));
  expect(skipLine).toContain('-'); // no discord => dash
});

test('dry-run flag reflected in header', () => {
  const out = buildCandidateReport(ROWS, { ...META, dry: true });
  expect(out).toContain('Dry-run: yes');
});

test('empty candidate set still renders header and a none marker', () => {
  const out = buildCandidateReport([], {
    ...META,
    candidates: 0,
    grants: 0,
    extensions: 0,
    skipped: 0,
    dmsRedelivered: 1
  });
  expect(out).toContain('Candidates: 0 | Granted: 0 | Extended: 0 | Skipped: 0');
  expect(out).toContain('(none)');
});
