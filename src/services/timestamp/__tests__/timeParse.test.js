import { describe, test, expect } from 'bun:test';
import { parseTimeOfDay, unixFromLocal, isValidZone } from '../timeParse.js';

describe('parseTimeOfDay', () => {
  test('parses 24-hour time', () => {
    expect(parseTimeOfDay('18:00')).toEqual({ hour: 18, minute: 0 });
  });

  test('parses 24-hour time with leading zero and minutes', () => {
    expect(parseTimeOfDay('09:05')).toEqual({ hour: 9, minute: 5 });
  });

  test('parses 12-hour time with uppercase meridiem', () => {
    expect(parseTimeOfDay('6:00 PM')).toEqual({ hour: 18, minute: 0 });
  });

  test('parses 12-hour time with lowercase meridiem', () => {
    expect(parseTimeOfDay('6:00 pm')).toEqual({ hour: 18, minute: 0 });
  });

  test('parses 12-hour hour-only form', () => {
    expect(parseTimeOfDay('6 PM')).toEqual({ hour: 18, minute: 0 });
  });

  test('12:30 AM is after midnight', () => {
    expect(parseTimeOfDay('12:30 AM')).toEqual({ hour: 0, minute: 30 });
  });

  test('12:00 PM is noon', () => {
    expect(parseTimeOfDay('12:00 PM')).toEqual({ hour: 12, minute: 0 });
  });

  test('rejects out-of-range 24-hour time', () => {
    expect(parseTimeOfDay('25:00')).toBeNull();
  });

  test('rejects out-of-range minutes', () => {
    expect(parseTimeOfDay('10:75')).toBeNull();
  });

  test('rejects gibberish', () => {
    expect(parseTimeOfDay('abc')).toBeNull();
  });

  test('rejects empty string', () => {
    expect(parseTimeOfDay('')).toBeNull();
  });
});

describe('isValidZone', () => {
  test('accepts a real IANA zone', () => {
    expect(isValidZone('Europe/Oslo')).toBe(true);
  });
  test('rejects a bogus zone', () => {
    expect(isValidZone('Mars/Phobos')).toBe(false);
  });
});

describe('unixFromLocal', () => {
  // 2026-07-01 18:00 in Europe/Oslo is CEST (UTC+2) => 16:00 UTC
  const OSLO_SUMMER_UNIX = 1782921600;

  test('converts a summer wall-clock time in Europe/Oslo (DST +2)', () => {
    expect(unixFromLocal('2026-07-01', '18:00', 'Europe/Oslo')).toEqual({ unix: OSLO_SUMMER_UNIX });
  });

  test('12-hour input yields the same instant as 24-hour input', () => {
    expect(unixFromLocal('2026-07-01', '6:00 PM', 'Europe/Oslo')).toEqual({ unix: OSLO_SUMMER_UNIX });
  });

  test('applies the winter offset for the same zone (DST +1)', () => {
    // 2026-01-15 12:00 in Europe/Oslo is CET (UTC+1) => 11:00 UTC
    expect(unixFromLocal('2026-01-15', '12:00', 'Europe/Oslo')).toEqual({ unix: 1768474800 });
  });

  test('UTC passes the wall clock straight through', () => {
    // 2026-07-01 16:00 UTC
    expect(unixFromLocal('2026-07-01', '16:00', 'UTC')).toEqual({ unix: 1782921600 });
  });

  test('accepts a valid leap day', () => {
    const r = unixFromLocal('2028-02-29', '00:00', 'UTC');
    expect(r.error).toBeUndefined();
    expect(typeof r.unix).toBe('number');
  });

  test('rejects an impossible date (Feb 30)', () => {
    expect(unixFromLocal('2026-02-30', '18:00', 'Europe/Oslo').error).toBe('invalid_date');
  });

  test('rejects Feb 29 in a non-leap year', () => {
    expect(unixFromLocal('2026-02-29', '12:00', 'UTC').error).toBe('invalid_date');
  });

  test('rejects a non-ISO date format', () => {
    expect(unixFromLocal('07/01/2026', '18:00', 'Europe/Oslo').error).toBe('invalid_date');
  });

  test('rejects an unparseable time', () => {
    expect(unixFromLocal('2026-07-01', 'half past six', 'Europe/Oslo').error).toBe('invalid_time');
  });

  test('rejects an invalid timezone', () => {
    expect(unixFromLocal('2026-07-01', '18:00', 'Mars/Phobos').error).toBe('invalid_zone');
  });
});
