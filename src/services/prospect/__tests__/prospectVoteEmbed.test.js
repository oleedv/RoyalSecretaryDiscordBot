import { describe, it, expect } from 'bun:test';
import { buildVoteEmbed } from '../prospectEmbeds.js';

const baseProspect = {
  alias: 'TestProspect',
  steam_id: '76561198000000000',
  mentor_id: '999',
  period_started_at: new Date(Date.now() - 28 * 86400000),
  created_at: new Date(Date.now() - 30 * 86400000),
  extra_days: 0,
};

describe('buildVoteEmbed', () => {
  it('always includes a Discord field with hours and messages', () => {
    const e = buildVoteEmbed(baseProspect, {
      voice: { totalSeconds: 16.5 * 3600 },
      messages: { totalMessages: 42 },
    }).toJSON();

    const discord = e.fields.find((f) => f.name === 'Discord');
    expect(discord).toBeTruthy();
    expect(discord.value).toContain('Hours: **16.5h**');
    expect(discord.value).toContain('Messages: **42**');
  });

  it('shows Discord field with placeholders when stats are missing', () => {
    const e = buildVoteEmbed(baseProspect, null).toJSON();
    const discord = e.fields.find((f) => f.name === 'Discord');
    expect(discord).toBeTruthy();
    expect(discord.value).toContain('Hours: **-**');
    expect(discord.value).toContain('Messages: **-**');
  });

  it('includes Server Time gameplay hours when playtime is provided', () => {
    const e = buildVoteEmbed(baseProspect, {
      playtime: { playtimeHours: 22, seedHours: 3 },
      combat: { kills: 1, deaths: 2, teamkills: 0, daysActive: 10 },
    }).toJSON();

    const serverTime = e.fields.find((f) => f.name === 'Server Time');
    expect(serverTime).toBeTruthy();
    expect(serverTime.value).toContain('Gameplay: **22h**');
  });
});
