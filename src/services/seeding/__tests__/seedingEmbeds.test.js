import { describe, test, expect } from 'bun:test';
import { buildSeedingCallEmbed, CALL_UPDATED_SUFFIX_RE } from '../seedingEmbeds.js';
import { callEmbedSignature } from '../seedingScheduler.js';

describe('buildSeedingCallEmbed', () => {
  test('includes relative updated timestamp in population line', () => {
    const embed = buildSeedingCallEmbed({
      layerName: 'GooseBay_Seed_v1',
      playerCount: 12,
      threshold: 40,
      updatedAt: 1_700_000_000,
    });
    const data = embed.toJSON();
    expect(data.description).toContain('`12 / 40 players` · updated <t:1700000000:R>');
  });

  test('shows unavailable with updated timestamp', () => {
    const embed = buildSeedingCallEmbed({
      playerCount: null,
      threshold: 40,
      updatedAt: 1_700_000_100,
    });
    const data = embed.toJSON();
    expect(data.description).toContain('`Population: unavailable` · updated <t:1700000100:R>');
  });

  test('hides Fastest Seed when zero', () => {
    const embed = buildSeedingCallEmbed({
      playerCount: 5,
      threshold: 40,
      fastestSeed: 0,
      avgSeedTime: 30,
      updatedAt: 1_700_000_000,
    });
    const fields = embed.toJSON().fields || [];
    expect(fields.some((f) => f.name === 'Fastest Seed')).toBe(false);
    expect(fields.some((f) => f.name === 'Avg Seed Time')).toBe(true);
  });

  test('shows Fastest Seed when positive', () => {
    const embed = buildSeedingCallEmbed({
      playerCount: 5,
      threshold: 40,
      fastestSeed: 12,
      updatedAt: 1_700_000_000,
    });
    const fields = embed.toJSON().fields || [];
    const fastest = fields.find((f) => f.name === 'Fastest Seed');
    expect(fastest?.value).toBe('12 min');
  });
});

describe('callEmbedSignature ignores updated timestamp', () => {
  test('same population with different updatedAt still matches', () => {
    const a = buildSeedingCallEmbed({
      playerCount: 9,
      threshold: 40,
      layerName: 'GooseBay_Seed_v1',
      updatedAt: 1_700_000_000,
    }).toJSON();
    const b = buildSeedingCallEmbed({
      playerCount: 9,
      threshold: 40,
      layerName: 'GooseBay_Seed_v1',
      updatedAt: 1_700_000_999,
    }).toJSON();
    expect(callEmbedSignature(a)).toBe(callEmbedSignature(b));
  });

  test('different population does not match', () => {
    const a = buildSeedingCallEmbed({
      playerCount: 9,
      threshold: 40,
      updatedAt: 1_700_000_000,
    }).toJSON();
    const b = buildSeedingCallEmbed({
      playerCount: 10,
      threshold: 40,
      updatedAt: 1_700_000_000,
    }).toJSON();
    expect(callEmbedSignature(a)).not.toBe(callEmbedSignature(b));
  });

  test('CALL_UPDATED_SUFFIX_RE strips the suffix', () => {
    const raw = '`9 / 40 players` · updated <t:1700000000:R>';
    expect(raw.replace(CALL_UPDATED_SUFFIX_RE, '')).toBe('`9 / 40 players`');
  });
});
