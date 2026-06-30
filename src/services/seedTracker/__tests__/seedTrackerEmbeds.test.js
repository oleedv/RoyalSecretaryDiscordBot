import { describe, test, expect } from 'bun:test';
import { buildMilestoneTrack, buildProgressionEmbed, buildLeaderboardEmbed, buildSeederThanksEmbed, buildExpiryWarningEmbed } from '../seedTrackerEmbeds.js';

const fieldNames = (embed) => embed.data.fields.map((f) => f.name);

describe('buildMilestoneTrack', () => {
  test('empty progress: all nodes hollow', () => {
    expect(buildMilestoneTrack(0, 10)).toBe('◯━━◯━━◯━━◯━━◯━━◯━━◯━━◯━━◯━━◯');
  });

  test('partial progress fills the reached nodes', () => {
    expect(buildMilestoneTrack(5, 10)).toBe('⬤━━⬤━━⬤━━⬤━━⬤━━◯━━◯━━◯━━◯━━◯');
  });

  test('goal reached fills every node', () => {
    expect(buildMilestoneTrack(10, 10)).toBe('⬤━━⬤━━⬤━━⬤━━⬤━━⬤━━⬤━━⬤━━⬤━━⬤');
  });

  test('done is clamped to total', () => {
    expect(buildMilestoneTrack(12, 10)).toBe(buildMilestoneTrack(10, 10));
  });

  test('no special halfway/goal glyphs', () => {
    expect(buildMilestoneTrack(3, 7)).toBe('⬤━━⬤━━⬤━━◯━━◯━━◯━━◯');
  });
});

describe('buildProgressionEmbed', () => {
  const base = { name: 'Jonas', steamId: '76561198000000000', uniqueDays: 5, required: 10, streak: 3 };

  test('renders the milestone track and day count, no legend', () => {
    const e = buildProgressionEmbed({ ...base });
    expect(e.data.description).toContain('⬤━━⬤━━⬤━━⬤━━⬤━━◯━━◯━━◯━━◯━━◯');
    expect(e.data.description).toContain('5 / 10 days');
    expect(e.data.description).not.toContain('halfway');
  });

  test('has no Quality field', () => {
    const e = buildProgressionEmbed({ ...base });
    expect(fieldNames(e)).not.toContain('Quality');
  });

  test('shows Resets when a deadline is given', () => {
    const e = buildProgressionEmbed({ ...base, seedAgainBy: new Date(1_700_000_000_000) });
    expect(fieldNames(e)).toContain('Resets');
    const field = e.data.fields.find((f) => f.name === 'Resets');
    expect(field.value).toContain('<t:');
  });

  test('omits Resets when no deadline', () => {
    const e = buildProgressionEmbed({ ...base, seedAgainBy: null });
    expect(fieldNames(e)).not.toContain('Resets');
  });

  test('sets the avatar thumbnail when provided', () => {
    const e = buildProgressionEmbed({ ...base, avatarUrl: 'https://avatars.steamstatic.com/x_full.jpg' });
    expect(e.data.thumbnail?.url).toBe('https://avatars.steamstatic.com/x_full.jpg');
  });

  test('omits the thumbnail when no avatar', () => {
    const e = buildProgressionEmbed({ ...base });
    expect(e.data.thumbnail).toBeUndefined();
  });

  test('appends the Discord mention when a discordId is given', () => {
    const e = buildProgressionEmbed({ ...base, discordId: '111222333' });
    expect(e.data.description).toContain('**Jonas** (<@111222333>)');
  });

  test('shows the bare name when no discordId', () => {
    const e = buildProgressionEmbed({ ...base });
    expect(e.data.description).toContain('**Jonas**');
    expect(e.data.description).not.toContain('<@');
  });
});

describe('buildLeaderboardEmbed', () => {
  test('lines do not expose Quality', () => {
    const e = buildLeaderboardEmbed(
      [{ name: 'Jonas', seedDays: 8, totalDuration: 3600, avgQuality: 0.9 }],
      30
    );
    expect(e.data.description).not.toContain('Quality');
    expect(e.data.description).toContain('Jonas');
  });
});

describe('buildSeederThanksEmbed', () => {
  test('renders a thank-you with the name', () => {
    const e = buildSeederThanksEmbed({ name: 'Anders', totalDays: 27 });
    expect(e.data.title).toBe('Thanks for seeding!');
    expect(e.data.description).toContain('Anders');
    expect(e.data.thumbnail).toBeUndefined();
  });

  test('always shows the total seeded field', () => {
    const e = buildSeederThanksEmbed({ name: 'Anders', totalDays: 27 });
    const total = e.data.fields.find((f) => f.name === 'Total seeded');
    expect(total?.value).toBe('27 days');
  });

  test('shows the streak field when at least 2 days', () => {
    const e = buildSeederThanksEmbed({ name: 'Anders', streak: 4, totalDays: 27 });
    const streak = e.data.fields.find((f) => f.name === 'Streak');
    expect(streak?.value).toBe('4 days');
  });

  test('hides the streak field when only 1 day', () => {
    const e = buildSeederThanksEmbed({ name: 'Anders', streak: 1, totalDays: 27 });
    expect(fieldNames(e)).not.toContain('Streak');
  });

  test('appends the Discord mention when a discordId is given', () => {
    const e = buildSeederThanksEmbed({ name: 'Anders', totalDays: 27, discordId: '111222333' });
    expect(e.data.description).toContain('**Anders** (<@111222333>)');
  });

  test('sets the thumbnail when an avatar is provided', () => {
    const e = buildSeederThanksEmbed({ name: 'Anders', avatarUrl: 'https://avatars.steamstatic.com/x_full.jpg' });
    expect(e.data.thumbnail?.url).toBe('https://avatars.steamstatic.com/x_full.jpg');
  });
});

describe('buildExpiryWarningEmbed', () => {
  const base = {
    name: 'Anders',
    steamId: '76561198000000000',
    expiresAt: new Date(1_700_000_000_000),
    uniqueDays: 8,
    required: 10,
    seedsNeeded: 2,
  };

  test('renders the renewal track and a relative expiry timestamp', () => {
    const e = buildExpiryWarningEmbed({ ...base });
    expect(e.data.title).toBe('Whitelist Expiring Soon');
    expect(e.data.description).toContain('⬤━━⬤━━⬤━━⬤━━⬤━━⬤━━⬤━━⬤━━◯━━◯');
    expect(e.data.description).toContain('8 / 10 days');
    const expires = e.data.fields.find((f) => f.name === 'Expires');
    expect(expires?.value).toContain('<t:');
    expect(expires?.value).toContain(':R>');
  });

  test('To renew shows the seeds-needed count', () => {
    const e = buildExpiryWarningEmbed({ ...base, seedsNeeded: 2 });
    const toRenew = e.data.fields.find((f) => f.name === 'To renew');
    expect(toRenew?.value).toBe('2 more days');
  });

  test('To renew nudges to seed once when none needed', () => {
    const e = buildExpiryWarningEmbed({ ...base, uniqueDays: 10, seedsNeeded: 0 });
    const toRenew = e.data.fields.find((f) => f.name === 'To renew');
    expect(toRenew?.value).toBe('Seed once to renew');
  });

  test('sets the avatar thumbnail when provided', () => {
    const e = buildExpiryWarningEmbed({ ...base, avatarUrl: 'https://avatars.steamstatic.com/x_full.jpg' });
    expect(e.data.thumbnail?.url).toBe('https://avatars.steamstatic.com/x_full.jpg');
  });

  test('appends the Discord mention when a discordId is given', () => {
    const e = buildExpiryWarningEmbed({ ...base, discordId: '111222333' });
    expect(e.data.description).toContain('**Anders** (<@111222333>)');
  });
});
