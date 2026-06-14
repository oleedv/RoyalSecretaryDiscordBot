import { describe, test, expect } from 'bun:test';
import { formatRotationList, buildSuccessEmbed } from '../layerRotationValidatorEmbeds.js';

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

describe('formatRotationList - current-map highlight', () => {
  const lines = [
    'Sumari_Seed_v1 USA MEI',
    'FoolsRoad_RAAS_v1 AFU RGF',
    'Sumari_Seed_v1 USA MEI',
  ];

  test('green-dots the current line and grey-dots the rest for alignment', () => {
    const rows = formatRotationList(lines, 'FoolsRoad_RAAS_v1').split('\n');
    expect(rows[1]).toBe(':green_circle: **2. Fools Road RAAS v1** - *AFU vs RGF*');
    expect(rows[0]).toBe(':white_circle: **1.** Sumari Seed v1 - *USA vs MEI*');
    expect(rows[2]).toBe(':white_circle: **3.** Sumari Seed v1 - *USA vs MEI*');
  });

  test('highlights only the first occurrence when the layer repeats', () => {
    const rows = formatRotationList(lines, 'Sumari_Seed_v1').split('\n');
    expect(rows[0]).toBe(':green_circle: **1. Sumari Seed v1** - *USA vs MEI*');
    expect(rows[2]).toBe(':white_circle: **3.** Sumari Seed v1 - *USA vs MEI*');
  });

  test('no dots at all when the current layer matches no line', () => {
    const out = formatRotationList(lines, 'Narva_RAAS_v1');
    expect(out).not.toContain(':green_circle:');
    expect(out).not.toContain(':white_circle:');
  });

  test('no dots when no current layer token is supplied (back-compat)', () => {
    const out = formatRotationList(lines);
    expect(out).not.toContain(':green_circle:');
    expect(out).not.toContain(':white_circle:');
  });
});

describe('buildSuccessEmbed - current map block', () => {
  const lines = ['Sumari_Seed_v1 USA MEI', 'Mutaha_RAAS_v1 RGF USMC'];

  test('adds Current map + Started lines and highlights the row when both live values are known', () => {
    const d = buildSuccessEmbed({ mode: 'LayerList', lines, currentLayer: 'Mutaha_RAAS_v1', matchStartTime: 1717003600 }).data.description;
    expect(d).toContain('Current map: Mutaha RAAS v1');
    expect(d).toContain('Started <t:1717003600:R>');
    expect(d).toContain(':green_circle: **2. Mutaha RAAS v1** - *RGF vs USMC*');
  });

  test('omits the Started line when matchStartTime is unknown', () => {
    const d = buildSuccessEmbed({ mode: 'LayerList', lines, currentLayer: 'Mutaha_RAAS_v1', matchStartTime: null }).data.description;
    expect(d).toContain('Current map: Mutaha RAAS v1');
    expect(d).not.toContain('Started <t:');
  });

  test('omits the whole block when currentLayer is unknown', () => {
    const d = buildSuccessEmbed({ mode: 'LayerList', lines, currentLayer: null, matchStartTime: 1717003600 }).data.description;
    expect(d).not.toContain('Current map:');
    expect(d).not.toContain('Started <t:');
  });

  test('back-compat: no live fields renders header + plain list', () => {
    const d = buildSuccessEmbed({ mode: 'LayerList', lines }).data.description;
    expect(d).toContain('Mode: LayerList');
    expect(d).not.toContain('Current map:');
    expect(d).not.toContain(':green_circle:');
  });
});
