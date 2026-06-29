import { describe, test, expect } from 'bun:test';
import { filterZones } from '../zones.js';

const ALL = [
  'Europe/Oslo',
  'Europe/London',
  'America/New_York',
  'America/Los_Angeles',
  'Asia/Tokyo',
];

describe('filterZones', () => {
  test('matches a city substring case-insensitively', () => {
    expect(filterZones(ALL, 'osl')).toEqual(['Europe/Oslo']);
    expect(filterZones(ALL, 'OSL')).toEqual(['Europe/Oslo']);
  });

  test('matches with underscores treated as spaces', () => {
    expect(filterZones(ALL, 'new york')).toEqual(['America/New_York']);
  });

  test('returns nothing when no zone matches', () => {
    expect(filterZones(ALL, 'zzz')).toEqual([]);
  });

  test('empty input returns the common list with the saved zone first', () => {
    const out = filterZones(ALL, '', {
      savedZone: 'America/New_York',
      common: ['Europe/London', 'Asia/Tokyo'],
    });
    expect(out[0]).toBe('America/New_York');
    expect(out).toContain('Europe/London');
    expect(out).toContain('Asia/Tokyo');
    expect(new Set(out).size).toBe(out.length); // no duplicates
  });

  test('a matching saved zone is hoisted to the front', () => {
    const out = filterZones(ALL, 'america', { savedZone: 'America/Los_Angeles' });
    expect(out[0]).toBe('America/Los_Angeles');
    expect(out).toContain('America/New_York');
  });

  test('caps results at 25', () => {
    const many = Array.from({ length: 40 }, (_, i) => `Etc/Zone_${i}`);
    expect(filterZones(many, 'zone')).toHaveLength(25);
  });
});
