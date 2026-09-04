import { describe, test, expect } from 'bun:test';
import { decideSeederAction, shouldThankToday, shouldRunForPeriod } from '../seederRewardLogic.js';

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

  // Regression: every completed session used to rewrite expiry to now+durationDays.
  // After a grant at NOW+30d, a reconnect 3 hours later is still now+30d+3h — a
  // few hours later, so the old `newMs <= currentMs` skip never fired and the
  // activity log filled with "Updated entry" rows.
  test('does not rewrite seeder expiry for a same-day bump', () => {
    const wl = { role: 'Seeder', expiresAt: new Date(NOW + 30 * DAY) };
    const r = decideSeederAction({ ...base, uniqueDays: 10, whitelist: wl, nowMs: NOW + 3 * 3600000 });
    expect(r.action).toBe('skip');
  });

  test('extends seeder expiry once the bump is at least a day', () => {
    const wl = { role: 'Seeder', expiresAt: new Date(NOW + 30 * DAY) };
    const r = decideSeederAction({ ...base, uniqueDays: 10, whitelist: wl, nowMs: NOW + DAY });
    expect(r.action).toBe('extend');
    expect(r.expiresAt.getTime()).toBe(NOW + DAY + 30 * DAY);
  });

  test('website member with leftover Seeder whitelist => thank (do not extend)', () => {
    const wl = { role: 'Seeder', expiresAt: new Date(NOW + 5 * DAY) };
    const r = decideSeederAction({ ...base, uniqueDays: 99, whitelist: wl, isMember: true });
    expect(r.action).toBe('thank');
  });

  test('website member with no whitelist => thank (do not grant)', () => {
    const r = decideSeederAction({ ...base, uniqueDays: 99, whitelist: null, isMember: true });
    expect(r.action).toBe('thank');
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

describe('shouldRunForPeriod', () => {
  test('null last-run marker => run', () => {
    expect(shouldRunForPeriod(null, '2026-06-30')).toBe(true);
  });

  test('earlier period => run', () => {
    expect(shouldRunForPeriod('2026-06-29', '2026-06-30')).toBe(true);
  });

  // Regression: a restart must NOT re-fire a task already done this period.
  // Previously the gate lived in an in-memory var that reset to null on every
  // boot, so each restart re-posted the daily expiry warnings.
  test('same period (e.g. after a restart) => do not run again', () => {
    expect(shouldRunForPeriod('2026-06-30', '2026-06-30')).toBe(false);
  });

  test('works for monthly keys too', () => {
    expect(shouldRunForPeriod('2026-5', '2026-5')).toBe(false);
    expect(shouldRunForPeriod('2026-4', '2026-5')).toBe(true);
  });
});
