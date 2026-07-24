import { describe, test, expect } from 'bun:test';
import { isAtOrPastResetTime, CHANNEL_RESET_TIME } from '../seedingScheduler.js';

describe('isAtOrPastResetTime', () => {
  test('default reset time is 04:00', () => {
    expect(CHANNEL_RESET_TIME).toBe('04:00');
  });

  test('before 04:00 is false', () => {
    expect(isAtOrPastResetTime('03:59')).toBe(false);
    expect(isAtOrPastResetTime('00:00')).toBe(false);
  });

  test('at or after 04:00 is true', () => {
    expect(isAtOrPastResetTime('04:00')).toBe(true);
    expect(isAtOrPastResetTime('04:01')).toBe(true);
    expect(isAtOrPastResetTime('16:00')).toBe(true);
    expect(isAtOrPastResetTime('23:59')).toBe(true);
  });

  test('accepts custom reset time', () => {
    expect(isAtOrPastResetTime('05:00', '06:00')).toBe(false);
    expect(isAtOrPastResetTime('06:00', '06:00')).toBe(true);
  });
});
