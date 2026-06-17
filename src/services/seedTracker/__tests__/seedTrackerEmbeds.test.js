import { describe, test, expect } from 'bun:test';
import { buildMilestoneTrack, buildProgressionEmbed, buildLeaderboardEmbed, buildSeederThanksEmbed } from '../seedTrackerEmbeds.js';

const fieldNames = (embed) => embed.data.fields.map((f) => f.name);

describe('buildMilestoneTrack', () => {
  test('empty progress: halfway/goal shown unfilled', () => {
    expect(buildMilestoneTrack(0, 10)).toBe('◯━━◯━━◯━━◯━━⬦━━◯━━◯━━◯━━◯━━⊙');
  });

  test('halfway reached fills the halfway diamond', () => {
    expect(buildMilestoneTrack(5, 10)).toBe('⬤━━⬤━━⬤━━⬤━━⬥━━◯━━◯━━◯━━◯━━⊙');
  });

  test('goal reached fills the goal marker', () => {
    expect(buildMilestoneTrack(10, 10)).toBe('⬤━━⬤━━⬤━━⬤━━⬥━━⬤━━⬤━━⬤━━⬤━━⨀');
  });

  test('done is clamped to total', () => {
    expect(buildMilestoneTrack(12, 10)).toBe(buildMilestoneTrack(10, 10));
  });

  test('non-default total places halfway at floor(total/2)', () => {
    expect(buildMilestoneTrack(3, 7)).toBe('⬤━━⬤━━⬥━━◯━━◯━━◯━━⊙');
  });
});

describe('buildProgressionEmbed', () => {
  const base = { name: 'Jonas', steamId: '76561198000000000', uniqueDays: 5, required: 10, streak: 3 };

  test('renders the milestone track and day count, no legend', () => {
    const e = buildProgressionEmbed({ ...base });
    expect(e.data.description).toContain('⬤━━⬤━━⬤━━⬤━━⬥━━◯━━◯━━◯━━◯━━⊙');
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
  test('renders a thank-you with the name and no stats', () => {
    const e = buildSeederThanksEmbed({ name: 'Anders' });
    expect(e.data.title).toBe('Thanks for seeding!');
    expect(e.data.description).toContain('Anders');
    expect(e.data.thumbnail).toBeUndefined();
    expect(e.data.fields ?? []).toHaveLength(0);
  });

  test('sets the thumbnail when an avatar is provided', () => {
    const e = buildSeederThanksEmbed({ name: 'Anders', avatarUrl: 'https://avatars.steamstatic.com/x_full.jpg' });
    expect(e.data.thumbnail?.url).toBe('https://avatars.steamstatic.com/x_full.jpg');
  });
});
