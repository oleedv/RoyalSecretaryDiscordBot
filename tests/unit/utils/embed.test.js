import { describe, it, expect } from 'bun:test';
import { createEmbed } from '../../../src/utils/embed.js';

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
