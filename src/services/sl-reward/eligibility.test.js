import { test, expect } from 'bun:test';
import { classifyWhitelist, decideRewardAction } from './eligibility.js';

const SL = 'cmq8eaiat03ym01qtcdgs7bri';
const NOW = new Date('2026-06-16T12:00:00Z').getTime();
const inHours = (h) => new Date(NOW + h * 3600 * 1000);

test('classifyWhitelist splits SL vs other, taking the first of each', () => {
  const { slEntry, otherEntry } = classifyWhitelist(
    [{ id: 'a', clanId: 'other' }, { id: 'b', clanId: SL }, { id: 'c', clanId: 'other2' }],
    SL
  );
  expect(slEntry.id).toBe('b');
  expect(otherEntry.id).toBe('a');
});

test('under threshold => skip', () => {
  const r = decideRewardAction({ rollingHours: 4.9, entries: [], slClanId: SL, nowMs: NOW });
  expect(r.action).toBe('skip');
  expect(r.reason).toBe('under_threshold');
});

test('threshold met, no whitelist => grant', () => {
  const r = decideRewardAction({ rollingHours: 5.0, entries: [], slClanId: SL, nowMs: NOW });
  expect(r.action).toBe('grant');
  expect(r.reason).toBe('first_grant');
});

test('threshold met but holds another whitelist => skip (do not stack)', () => {
  const entries = [{ id: 'x', clanId: 'paid', expiresAt: inHours(720) }];
  const r = decideRewardAction({ rollingHours: 7, entries, slClanId: SL, nowMs: NOW });
  expect(r.action).toBe('skip');
  expect(r.reason).toBe('has_other_whitelist');
});

test('SL entry expiring within 24h => extend', () => {
  const entries = [{ id: 'sl', clanId: SL, expiresAt: inHours(12) }];
  const r = decideRewardAction({ rollingHours: 6, entries, slClanId: SL, nowMs: NOW });
  expect(r.action).toBe('extend');
  expect(r.slEntry.id).toBe('sl');
});

test('SL entry with plenty of time left => skip (still active)', () => {
  const entries = [{ id: 'sl', clanId: SL, expiresAt: inHours(120) }];
  const r = decideRewardAction({ rollingHours: 6, entries, slClanId: SL, nowMs: NOW });
  expect(r.action).toBe('skip');
  expect(r.reason).toBe('still_active');
});

test('permanent SL entry (no expiry) => skip, never extend into NULL', () => {
  const entries = [{ id: 'sl', clanId: SL, expiresAt: null }];
  const r = decideRewardAction({ rollingHours: 6, entries, slClanId: SL, nowMs: NOW });
  expect(r.action).toBe('skip');
  expect(r.reason).toBe('still_active');
});
