import { describe, test, expect } from 'bun:test';
import { decideSeederAction, shouldThankToday } from '../seederRewardLogic.js';

const DAY = 86400000;
const NOW = 1_700_000_000_000; // fixed reference instant
const base = { requiredDays: 10, durationDays: 30, maxExtensionDays: 60, nowMs: NOW, minProgressionDays: 2 };

describe('decideSeederAction', () => {
  test('non-Seeder whitelist (clan/admin) => thank', () => {
    const r = decideSeederAction({ ...base, uniqueDays: 99, whitelist: { role: 'Admin', expiresAt: null } });
    expect(r.action).toBe('thank');
  });

  test('non-Seeder whitelist below threshold also => thank', () => {
    const r = decideSeederAction({ ...base, uniqueDays: 1, whitelist: { role: 'Clan', expiresAt: new Date(NOW + 5 * DAY) } });
    expect(r.action).toBe('thank');
  });

  test('no whitelist + below threshold = progression', () => {
    const r = decideSeederAction({ ...base, uniqueDays: 4, whitelist: null });
    expect(r.action).toBe('progression');
  });

  test('no whitelist + 1 seed day (one-time connect) => skip (gated)', () => {
    const r = decideSeederAction({ ...base, uniqueDays: 1, whitelist: null });
    expect(r.action).toBe('skip');
  });

  test('no whitelist + exactly minProgressionDays => progression', () => {
    const r = decideSeederAction({ ...base, uniqueDays: 2, whitelist: null });
    expect(r.action).toBe('progression');
  });

  test('no whitelist + at threshold = grant', () => {
    const r = decideSeederAction({ ...base, uniqueDays: 10, whitelist: null });
    expect(r.action).toBe('grant');
  });

  test('Seeder whitelist below threshold = skip (no extension)', () => {
    const wl = { role: 'Seeder', expiresAt: new Date(NOW + 5 * DAY) };
    expect(decideSeederAction({ ...base, uniqueDays: 9, whitelist: wl }).action).toBe('skip');
  });

  test('Seeder whitelist at threshold extends by durationDays', () => {
    const wl = { role: 'Seeder', expiresAt: new Date(NOW + 5 * DAY) };
    const r = decideSeederAction({ ...base, uniqueDays: 10, whitelist: wl });
    expect(r.action).toBe('extend');
    expect(r.expiresAt.getTime()).toBe(NOW + 30 * DAY);
  });

  test('extension is capped at maxExtensionDays from now', () => {
    const wl = { role: 'Seeder', expiresAt: new Date(NOW + 5 * DAY) };
    const r = decideSeederAction({ ...base, durationDays: 90, uniqueDays: 10, whitelist: wl });
    expect(r.action).toBe('extend');
    expect(r.expiresAt.getTime()).toBe(NOW + 60 * DAY); // capped
  });

  test('does not shorten an expiry that is already later than the new one', () => {
    const wl = { role: 'Seeder', expiresAt: new Date(NOW + 50 * DAY) };
    const r = decideSeederAction({ ...base, uniqueDays: 10, whitelist: wl });
    expect(r.action).toBe('skip');
  });
});

describe('shouldThankToday', () => {
  test('null last date => thank', () => {
    expect(shouldThankToday(null, '2026-06-17')).toBe(true);
  });

  test('earlier date => thank', () => {
    expect(shouldThankToday('2026-06-16', '2026-06-17')).toBe(true);
  });

  test('same date => do not thank', () => {
    expect(shouldThankToday('2026-06-17', '2026-06-17')).toBe(false);
  });
});
