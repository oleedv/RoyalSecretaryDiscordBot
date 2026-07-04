import { describe, it, expect } from 'bun:test';
import { buildProspectWelcomeEmbed } from '../prospectEmbeds.js';

const member = { user: { displayAvatarURL: () => 'https://cdn/avatar.png' } };
const prospect = { user_id: '12345' };
const CHANNELS = {
  prospectInfoChannelId: '111',
  prospectIntroChannelId: '222',
  prospectAwayChannelId: '333',
  feedbackChannelId: '444',
};

describe('buildProspectWelcomeEmbed', () => {
  it('mentions the prospect and shows their avatar as the thumbnail', () => {
    const e = buildProspectWelcomeEmbed(member, prospect, CHANNELS);
    expect(e.data.description).toContain('<@12345>');
    expect(e.data.thumbnail.url).toBe('https://cdn/avatar.png');
    expect(e.data.color).toBe(0x57f287);
    expect(e.data.footer.text).toBe('Royal Battalion ● Prospect');
    expect(e.data.title).toBe('Welcome to the Prospect Lounge');
  });

  it('adds one field per configured channel, each pointing to that channel', () => {
    const e = buildProspectWelcomeEmbed(member, prospect, CHANNELS);
    const fields = e.data.fields || [];
    expect(fields.length).toBe(4);
    expect(fields.some((f) => f.value.includes('<#111>'))).toBe(true);
    expect(fields.some((f) => f.value.includes('<#222>'))).toBe(true);
    expect(fields.some((f) => f.value.includes('<#333>'))).toBe(true);
    expect(fields.some((f) => f.value.includes('<#444>'))).toBe(true);
  });

  it('omits fields for unconfigured channels and never emits an empty mention', () => {
    const e = buildProspectWelcomeEmbed(member, prospect, { prospectIntroChannelId: '222' });
    const fields = e.data.fields || [];
    expect(fields.length).toBe(1);
    expect(fields[0].value).toContain('<#222>');
    for (const f of fields) expect(f.value).not.toContain('<#>');
  });

  it('omits the thumbnail when member is null', () => {
    const e = buildProspectWelcomeEmbed(null, prospect, CHANNELS);
    expect(e.data.thumbnail).toBeUndefined();
  });
});
