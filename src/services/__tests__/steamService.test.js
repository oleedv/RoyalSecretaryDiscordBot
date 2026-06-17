import { describe, test, expect } from 'bun:test';
import { buildAvatarUrl, isAvatarFresh, AVATAR_REFRESH_DAYS } from '../steamService.js';

const DAY = 86400000;
const NOW = 1_700_000_000_000;

describe('buildAvatarUrl', () => {
  test('builds the full-size CDN url from a hash', () => {
    expect(buildAvatarUrl('abc123')).toBe('https://avatars.steamstatic.com/abc123_full.jpg');
  });
  test('returns null for a missing hash', () => {
    expect(buildAvatarUrl(null)).toBeNull();
  });
});

describe('isAvatarFresh', () => {
  test('fresh within the refresh window', () => {
    expect(isAvatarFresh(new Date(NOW - 5 * DAY), NOW)).toBe(true);
  });
  test('stale past the refresh window', () => {
    expect(isAvatarFresh(new Date(NOW - (AVATAR_REFRESH_DAYS + 1) * DAY), NOW)).toBe(false);
  });
  test('null last-checked is never fresh', () => {
    expect(isAvatarFresh(null, NOW)).toBe(false);
  });
});
