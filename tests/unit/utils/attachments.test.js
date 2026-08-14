import { describe, it, expect } from 'bun:test';
import { Collection } from 'discord.js';
import {
  applyAttachments,
  canReuploadAttachment,
  MAX_RELAY_REUPLOAD_BYTES,
} from '../../../src/utils/attachments.js';

function mockEmbed() {
  const fields = [];
  return {
    fields,
    setImage(url) {
      this.image = url;
      return this;
    },
    addFields(field) {
      fields.push(field);
      return this;
    },
  };
}

describe('canReuploadAttachment', () => {
  it('allows small files and unknown sizes', () => {
    expect(canReuploadAttachment({ url: 'https://cdn/a.mp4', size: 1024 })).toBe(true);
    expect(canReuploadAttachment({ url: 'https://cdn/a.mp4' })).toBe(true);
  });

  it('rejects files over the re-upload budget', () => {
    expect(canReuploadAttachment({
      url: 'https://cdn/big.mp4',
      size: MAX_RELAY_REUPLOAD_BYTES + 1,
    })).toBe(false);
  });

  it('rejects missing url', () => {
    expect(canReuploadAttachment({ name: 'x.mp4', size: 100 })).toBe(false);
    expect(canReuploadAttachment(null)).toBe(false);
  });
});

describe('applyAttachments', () => {
  it('embeds the first image and lists all attachment links', () => {
    const attachments = new Collection([
      ['1', { name: 'shot.png', url: 'https://cdn/shot.png', contentType: 'image/png', size: 500 }],
      ['2', { name: 'notes.txt', url: 'https://cdn/notes.txt', contentType: 'text/plain', size: 20 }],
    ]);
    const embed = mockEmbed();
    const sendOptions = {};

    applyAttachments(embed, sendOptions, attachments);

    expect(embed.image).toBe('https://cdn/shot.png');
    expect(embed.fields[0].name).toBe('Attachments');
    expect(embed.fields[0].value).toContain('[shot.png](https://cdn/shot.png)');
    expect(embed.fields[0].value).toContain('[notes.txt](https://cdn/notes.txt)');
    expect(sendOptions.files).toEqual([
      { attachment: 'https://cdn/notes.txt', name: 'notes.txt' },
    ]);
  });

  it('does not re-upload oversized videos (link-only) to avoid AbortError timeouts', () => {
    const attachments = new Collection([
      ['1', {
        name: 'clip.mp4',
        url: 'https://cdn/clip.mp4',
        contentType: 'video/mp4',
        size: 25 * 1024 * 1024,
      }],
    ]);
    const embed = mockEmbed();
    const sendOptions = {};

    applyAttachments(embed, sendOptions, attachments);

    expect(embed.fields[0].value).toContain('[clip.mp4](https://cdn/clip.mp4)');
    expect(sendOptions.files).toBeUndefined();
  });

  it('re-uploads small non-image files', () => {
    const attachments = new Collection([
      ['1', {
        name: 'clip.mp4',
        url: 'https://cdn/clip.mp4',
        contentType: 'video/mp4',
        size: 2 * 1024 * 1024,
      }],
    ]);
    const sendOptions = {};

    applyAttachments(mockEmbed(), sendOptions, attachments);

    expect(sendOptions.files).toEqual([
      { attachment: 'https://cdn/clip.mp4', name: 'clip.mp4' },
    ]);
  });

  it('no-ops when there are no attachments', () => {
    const embed = mockEmbed();
    const sendOptions = {};
    applyAttachments(embed, sendOptions, new Collection());
    expect(embed.fields).toHaveLength(0);
    expect(sendOptions.files).toBeUndefined();
  });
});
