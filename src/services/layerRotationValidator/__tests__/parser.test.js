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

import { prettifyLayerToken } from '../layerRotationValidatorEmbeds.js';

describe('prettifyLayerToken', () => {
  test('parses a standard CamelCase map line', () => {
    expect(prettifyLayerToken('FoolsRoad_RAAS_v1 AFU RGF')).toEqual({
      map: 'Fools Road', variant: 'RAAS v1', team1: 'AFU', team2: 'RGF',
    });
  });

  test('parses a single-word map name', () => {
    expect(prettifyLayerToken('Sumari_Seed_v1 USA MEI')).toEqual({
      map: 'Sumari', variant: 'Seed v1', team1: 'USA', team2: 'MEI',
    });
  });

  test('parses BlackCoast and GooseBay', () => {
    expect(prettifyLayerToken('BlackCoast_RAAS_v1 PLA+Motorized CAF+Motorized')).toEqual({
      map: 'Black Coast', variant: 'RAAS v1', team1: 'PLA + Motorized', team2: 'CAF + Motorized',
    });
    expect(prettifyLayerToken('GooseBay_RAAS_v2 CAF CRF')).toEqual({
      map: 'Goose Bay', variant: 'RAAS v2', team1: 'CAF', team2: 'CRF',
    });
  });

  test('joins faction unit suffixes with spaces around +', () => {
    expect(prettifyLayerToken('Lashkar_RAAS_v1 CAF+AirAssault WPMC+AirAssault')).toEqual({
      map: 'Lashkar', variant: 'RAAS v1', team1: 'CAF + AirAssault', team2: 'WPMC + AirAssault',
    });
  });

  test('renders missing teams as -', () => {
    expect(prettifyLayerToken('Mestia_TC_v1')).toEqual({
      map: 'Mestia', variant: 'TC v1', team1: '-', team2: '-',
    });
  });

  test('handles missing version', () => {
    expect(prettifyLayerToken('Sumari_RAAS USA MEI')).toEqual({
      map: 'Sumari', variant: 'RAAS', team1: 'USA', team2: 'MEI',
    });
  });

  test('handles multi-segment map names', () => {
    expect(prettifyLayerToken('Black_Coast_RAAS_v1 PLA CAF')).toEqual({
      map: 'Black Coast', variant: 'RAAS v1', team1: 'PLA', team2: 'CAF',
    });
  });

  test('falls back gracefully on a single-token layer', () => {
    expect(prettifyLayerToken('SomeRawToken USA MEI')).toEqual({
      map: 'SomeRawToken', variant: '', team1: 'USA', team2: 'MEI',
    });
  });
});
