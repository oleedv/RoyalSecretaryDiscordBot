import { describe, test, expect } from 'bun:test';
import { parseMapRotationMode, parseLayerRotation } from '../layerRotationValidatorService.js';

describe('parseMapRotationMode', () => {
  test('reads a simple uncommented line', () => {
    expect(parseMapRotationMode('MapRotationMode=LayerList')).toBe('LayerList');
  });

  test('reads LayerList_Vote', () => {
    expect(parseMapRotationMode('MapRotationMode=LayerList_Vote')).toBe('LayerList_Vote');
  });

  test('returns the first uncommented value when both forms appear', () => {
    const cfg = [
      'MapRotationMode=LayerList_Vote',
      '//MapRotationMode=LayerList',
    ].join('\n');
    expect(parseMapRotationMode(cfg)).toBe('LayerList_Vote');
  });

  test('skips // comments with surrounding whitespace', () => {
    const cfg = [
      '   //  MapRotationMode=LayerList',
      'MapRotationMode=LayerList_Vote',
    ].join('\n');
    expect(parseMapRotationMode(cfg)).toBe('LayerList_Vote');
  });

  test('skips # comments', () => {
    const cfg = [
      '# MapRotationMode=LayerList',
      'MapRotationMode=Random',
    ].join('\n');
    expect(parseMapRotationMode(cfg)).toBe('Random');
  });

  test('tolerates whitespace around = and at line edges', () => {
    expect(parseMapRotationMode('  MapRotationMode  =  LayerList  ')).toBe('LayerList');
  });

  test('returns null when every MapRotationMode line is commented', () => {
    const cfg = [
      '//MapRotationMode=LayerList',
      '# MapRotationMode=LayerList_Vote',
    ].join('\n');
    expect(parseMapRotationMode(cfg)).toBeNull();
  });

  test('returns null when the directive is absent', () => {
    expect(parseMapRotationMode('ServerName=Royal Battalion\nMaxPlayers=80')).toBeNull();
  });

  test('handles CRLF line endings', () => {
    expect(parseMapRotationMode('MapRotationMode=LayerList\r\n')).toBe('LayerList');
  });
});

describe('parseLayerRotation', () => {
  test('strips blank lines and trims trailing whitespace', () => {
    const cfg = [
      '',
      'Sumari_Seed_v1 USA MEI   ',
      '',
      'FoolsRoad_RAAS_v1 AFU RGF',
      '',
    ].join('\n');
    const { cleanedText, lines } = parseLayerRotation(cfg);
    expect(lines).toEqual([
      'Sumari_Seed_v1 USA MEI',
      'FoolsRoad_RAAS_v1 AFU RGF',
    ]);
    expect(cleanedText).toBe('Sumari_Seed_v1 USA MEI\nFoolsRoad_RAAS_v1 AFU RGF');
  });

  test('strips // and # comment lines', () => {
    const cfg = [
      '// disabled rotation slot',
      'Sumari_Seed_v1 USA MEI',
      '# also disabled',
      'FoolsRoad_RAAS_v1 AFU RGF',
    ].join('\n');
    const { lines } = parseLayerRotation(cfg);
    expect(lines).toEqual([
      'Sumari_Seed_v1 USA MEI',
      'FoolsRoad_RAAS_v1 AFU RGF',
    ]);
  });

  test('handles CRLF line endings', () => {
    const cfg = 'Sumari_Seed_v1 USA MEI\r\nFoolsRoad_RAAS_v1 AFU RGF\r\n';
    const { lines } = parseLayerRotation(cfg);
    expect(lines).toEqual([
      'Sumari_Seed_v1 USA MEI',
      'FoolsRoad_RAAS_v1 AFU RGF',
    ]);
  });

  test('keeps single-token lines (mestia-style maps without explicit factions)', () => {
    const { lines } = parseLayerRotation('Mestia_TC_v1');
    expect(lines).toEqual(['Mestia_TC_v1']);
  });

  test('returns empty arrays for empty/blank input', () => {
    expect(parseLayerRotation('').lines).toEqual([]);
    expect(parseLayerRotation('\n\n  \n').lines).toEqual([]);
  });
});
