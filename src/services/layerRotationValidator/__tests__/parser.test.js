import { describe, test, expect } from 'bun:test';
import { parseMapRotationMode } from '../layerRotationValidatorService.js';

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
