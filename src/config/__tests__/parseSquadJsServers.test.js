import { describe, test, expect } from 'bun:test';
import { parseSquadJsServers } from '../parseSquadJsServers.js';

describe('parseSquadJsServers', () => {
  test('returns [] for empty/undefined input', () => {
    expect(parseSquadJsServers('')).toEqual([]);
    expect(parseSquadJsServers(undefined)).toEqual([]);
  });

  test('parses a single 4-field entry into name/url/token/serverId', () => {
    expect(parseSquadJsServers('main|ws://h:4000|tok|1')).toEqual([
      { name: 'main', url: 'ws://h:4000', token: 'tok', serverId: 1 },
    ]);
  });

  test('serverId is null when the 4th field is missing or blank', () => {
    expect(parseSquadJsServers('main|ws://h:4000|tok')[0].serverId).toBeNull();
    expect(parseSquadJsServers('main|ws://h:4000|tok|')[0].serverId).toBeNull();
  });

  test('parses multiple comma-separated entries and trims whitespace', () => {
    const result = parseSquadJsServers(' main|ws://a|t1|1 , battle|ws://b|t2|2 ');
    expect(result).toEqual([
      { name: 'main', url: 'ws://a', token: 't1', serverId: 1 },
      { name: 'battle', url: 'ws://b', token: 't2', serverId: 2 },
    ]);
  });

  test('non-numeric serverId becomes null (never NaN)', () => {
    expect(parseSquadJsServers('main|ws://h|tok|abc')[0].serverId).toBeNull();
  });
});
