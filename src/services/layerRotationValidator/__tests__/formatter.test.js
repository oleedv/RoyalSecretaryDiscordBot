import { describe, test, expect } from 'bun:test';
import { formatRotationList } from '../layerRotationValidatorEmbeds.js';

describe('formatRotationList', () => {
  test('renders bold-indexed lines with italicised teams', () => {
    const lines = [
      'Sumari_Seed_v1 USA MEI',
      'FoolsRoad_RAAS_v1 AFU RGF',
    ];
    const out = formatRotationList(lines);
    expect(out).toBe(
      '**1.** Sumari Seed v1 - *USA vs MEI*\n' +
      '**2.** Fools Road RAAS v1 - *AFU vs RGF*'
    );
  });

  test('joins faction units with + (no surrounding spaces)', () => {
    const lines = ['Lashkar_RAAS_v1 CAF+AirAssault WPMC+AirAssault'];
    const out = formatRotationList(lines);
    expect(out).toBe('**1.** Lashkar RAAS v1 - *CAF+AirAssault vs WPMC+AirAssault*');
  });

  test('omits the team suffix when both teams are missing', () => {
    expect(formatRotationList(['Mestia_TC_v1'])).toBe('**1.** Mestia TC v1');
  });

  test('renders only the present team when one is missing', () => {
    // Spec-defensive: not expected in real cfg but covered.
    expect(formatRotationList(['Sumari_Seed_v1 USA'])).toBe('**1.** Sumari Seed v1 - *USA*');
  });

  test('returns "(empty rotation)" for empty input', () => {
    expect(formatRotationList([])).toBe('(empty rotation)');
  });

  test('indexes are 1-based and continue past 9 without padding', () => {
    const lines = Array.from({ length: 12 }, () => 'Sumari_RAAS_v1 USA MEI');
    const rows = formatRotationList(lines).split('\n');
    expect(rows[0]).toBe('**1.** Sumari RAAS v1 - *USA vs MEI*');
    expect(rows[11]).toBe('**12.** Sumari RAAS v1 - *USA vs MEI*');
  });
});
