import { describe, it, expect } from 'bun:test';
import { classifyStatField, buildOrderedStatFields } from '../prospectStatsFields.js';

describe('classifyStatField', () => {
  it('classifies activity blocks by prefix despite dynamic suffix', () => {
    expect(classifyStatField('Game Activity (14d in)')).toBe('activity');
    expect(classifyStatField('Seeding (3d in)')).toBe('activity');
    expect(classifyStatField('Discord Activity (14d in)')).toBe('activity');
  });
  it('classifies background-check blocks', () => {
    expect(classifyStatField('Community Ban List')).toBe('check');
    expect(classifyStatField('BattleMetrics Bans')).toBe('check');
    expect(classifyStatField('BattleMetrics Flags')).toBe('check');
    expect(classifyStatField('BattleMetrics Staff Notes')).toBe('check');
    expect(classifyStatField('Steam Bans')).toBe('check');
  });
  it('classifies the last-updated field', () => {
    expect(classifyStatField('Last updated')).toBe('lastUpdated');
  });
  it('returns null for application fields and empty', () => {
    expect(classifyStatField('Alias')).toBe(null);
    expect(classifyStatField('Why RB?')).toBe(null);
    expect(classifyStatField(undefined)).toBe(null);
  });
});

describe('buildOrderedStatFields', () => {
  const existing = [
    { name: 'Alias', value: 'X' },
    { name: 'Game Activity (5d in)', value: 'old' },
    { name: 'Steam Bans', value: 'clean' },
    { name: 'Last updated', value: 'old-ts' },
  ];
  it('keeps canonical order when nothing replaced', () => {
    const out = buildOrderedStatFields(existing, {});
    expect(out.map((f) => f.name)).toEqual(['Alias', 'Game Activity (5d in)', 'Steam Bans', 'Last updated']);
  });
  it('replaces only activity + lastUpdated, preserves checks', () => {
    const out = buildOrderedStatFields(existing, {
      newActivity: [{ name: 'Game Activity (6d in)', value: 'fresh' }],
      newLastUpdated: [{ name: 'Last updated', value: 'new-ts' }],
    });
    expect(out.map((f) => f.name)).toEqual(['Alias', 'Game Activity (6d in)', 'Steam Bans', 'Last updated']);
    expect(out.find((f) => f.name === 'Steam Bans').value).toBe('clean');
    expect(out.find((f) => f.name === 'Last updated').value).toBe('new-ts');
  });
  it('replaces only checks, preserves activity + lastUpdated', () => {
    const out = buildOrderedStatFields(existing, { newChecks: [{ name: 'Community Ban List', value: 'flagged' }] });
    expect(out.map((f) => f.name)).toEqual(['Alias', 'Game Activity (5d in)', 'Community Ban List', 'Last updated']);
  });
  it('clears activity when empty array passed (pre-accept)', () => {
    const out = buildOrderedStatFields(existing, { newActivity: [], newLastUpdated: [] });
    expect(out.map((f) => f.name)).toEqual(['Alias', 'Steam Bans']);
  });
});
