import { describe, test, expect } from 'bun:test';
import { pickServerStateById, coerceServerId } from '../serverResolver.js';

describe('coerceServerId', () => {
  test('passes through positive integers', () => {
    expect(coerceServerId(1)).toBe(1);
    expect(coerceServerId('2')).toBe(2);
  });
  test('returns null for null/blank/non-numeric', () => {
    expect(coerceServerId(null)).toBeNull();
    expect(coerceServerId('')).toBeNull();
    expect(coerceServerId('abc')).toBeNull();
  });
});

describe('pickServerStateById', () => {
  const entries = [
    { serverId: 1, state: { connected: true, playerCount: 12 } },
    { serverId: 2, state: { connected: true, playerCount: 80 } },
  ];

  test('returns the state whose serverId matches', () => {
    expect(pickServerStateById(entries, 2).playerCount).toBe(80);
  });

  test('returns null when serverId is null (no silent fallback)', () => {
    expect(pickServerStateById(entries, null)).toBeNull();
  });

  test('returns null when no entry matches (no silent fallback)', () => {
    expect(pickServerStateById(entries, 99)).toBeNull();
  });

  test('returns null for an empty connection set', () => {
    expect(pickServerStateById([], 1)).toBeNull();
  });
});
