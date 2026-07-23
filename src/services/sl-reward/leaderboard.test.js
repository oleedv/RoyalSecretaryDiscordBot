import { test, expect } from 'bun:test';
import { buildLeaderboardRows, formatLeaderboardTable } from './leaderboard.js';

const SL = 'cmq8eaiat03ym01qtcdgs7bri';

test('buildLeaderboardRows merges users, badges whitelist, prefers Discord name', () => {
  const topRows = [
    { steam_id: 'AAA', in_game_name: 'IngameAlpha', hours: 4.84 },
    { steam_id: 'BBB', in_game_name: 'IngameBeta', hours: 4.2 },
    { steam_id: 'CCC', in_game_name: 'IngameGamma', hours: 3.95 }
  ];
  const users = [{ steamId: 'AAA', discordName: 'DiscordAlpha' }];
  const whitelist = [
    { steamId: 'AAA', clanId: SL },
    { steamId: 'BBB', clanId: 'OTHER' }
  ];
  const out = buildLeaderboardRows({ topRows, users, whitelist, slClanId: SL });
  expect(out[0]).toEqual({ rank: 1, displayName: 'DiscordAlpha', hours: '4.8', badge: '✓ SL' });
  expect(out[1]).toEqual({ rank: 2, displayName: 'IngameBeta', hours: '4.2', badge: '✓' });
  expect(out[2]).toEqual({ rank: 3, displayName: 'IngameGamma', hours: '4.0', badge: '-' });
});

test('formatLeaderboardTable: empty', () => {
  expect(formatLeaderboardTable([])).toBe('No qualifying SL time in the last 7 days.');
});

test('formatLeaderboardTable: truncates long display names', () => {
  const out = formatLeaderboardTable([
    { rank: 1, displayName: 'x'.repeat(40), hours: '5.0', badge: '✓ SL' }
  ]);
  expect(out).toContain('x'.repeat(23) + '…');
  expect(out).not.toContain('x'.repeat(25));
});
