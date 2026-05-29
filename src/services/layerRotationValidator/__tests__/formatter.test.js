import { describe, test, expect } from 'bun:test';
import { formatRotationTable } from '../layerRotationValidatorEmbeds.js';

describe('formatRotationTable', () => {
  test('produces a header and one row per layer with aligned columns', () => {
    const lines = [
      'Sumari_Seed_v1 USA MEI',
      'FoolsRoad_RAAS_v1 AFU RGF',
    ];
    const out = formatRotationTable(lines);
    const rows = out.split('\n');
    expect(rows[0]).toMatch(/^ #\s+Map\s+Variant\s+Team 1\s+Team 2\s*$/);
    expect(rows[1]).toMatch(/^ 1\s+Sumari\s+Seed v1\s+USA\s+MEI\s*$/);
    expect(rows[2]).toMatch(/^ 2\s+Fools Road\s+RAAS v1\s+AFU\s+RGF\s*$/);
    const widths = rows.filter(Boolean).map((r) => r.length);
    expect(new Set(widths).size).toBe(1);
  });

  test('renders missing teams as -', () => {
    const lines = ['Mestia_TC_v1'];
    const out = formatRotationTable(lines);
    expect(out).toMatch(/Mestia\s+TC v1\s+-\s+-/);
  });

  test('right-pads numeric index to fit the highest row number', () => {
    const lines = Array.from({ length: 12 }, () => 'Sumari_RAAS_v1 USA MEI');
    const out = formatRotationTable(lines);
    const rows = out.split('\n').filter(Boolean);
    expect(rows.length).toBe(13);
    expect(rows[12]).toMatch(/^12\s+Sumari/);
    expect(rows[1]).toMatch(/^ 1\s+Sumari/);
  });

  test('returns "(empty rotation)" for an empty input', () => {
    expect(formatRotationTable([])).toBe('(empty rotation)');
  });
});
