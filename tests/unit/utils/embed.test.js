import { describe, it, expect } from 'bun:test';
import { createEmbed, buildRelayEmbed } from '../../../src/utils/embed.js';

describe('createEmbed footer', () => {
  it('includes the type label when a type is provided', () => {
    const e = createEmbed('Ticket');
    expect(e.data.footer.text).toBe('Royal Battalion ● Ticket');
  });

  it('shows just the brand and never "undefined" when no type is given', () => {
    const e = createEmbed();
    expect(e.data.footer.text).toBe('Royal Battalion');
    expect(e.data.footer.text).not.toContain('undefined');
  });
});

describe('buildRelayEmbed', () => {
  it('shows the staff name, avatar and blue color when not anonymous', () => {
    const e = buildRelayEmbed({
      type: 'Ticket',
      senderName: 'Alice',
      avatarUrl: 'https://cdn/avatar.png',
      content: 'hello there',
    });
    expect(e.data.author.name).toBe('Alice');
    expect(e.data.author.icon_url).toBe('https://cdn/avatar.png');
    expect(e.data.color).toBe(0x5865f2);
    expect(e.data.description).toBe('hello there');
    expect(e.data.footer.text).toBe('Royal Battalion ● Ticket');
  });

  it('hides the avatar and uses grey when anonymous', () => {
    const e = buildRelayEmbed({
      type: 'Ticket',
      senderName: 'Staff',
      avatarUrl: 'https://cdn/avatar.png',
      content: 'hello',
      anonymous: true,
    });
    expect(e.data.author.name).toBe('Staff');
    expect(e.data.author.icon_url).toBeUndefined();
    expect(e.data.color).toBe(0x99aab5);
  });

  it('falls back to an attachment-only placeholder when content is empty', () => {
    const e = buildRelayEmbed({ type: 'Prospect', senderName: 'Bob', content: '' });
    expect(e.data.description).toBe('*Attachment only*');
  });
});
