import { describe, test, expect } from 'bun:test';
import {
  STYLES,
  renderCode,
  isValidStyle,
  buildPreviewText,
  buildComponents,
  postCustomId,
  parsePostCustomId,
  styleSelectCustomId,
  parseStyleSelectCustomId,
} from '../timestampView.js';

const UNIX = 1782921600;

describe('renderCode', () => {
  test('builds a Discord timestamp token', () => {
    expect(renderCode(UNIX, 'F')).toBe(`<t:${UNIX}:F>`);
  });
});

describe('isValidStyle', () => {
  test('accepts every supported style', () => {
    for (const { style } of STYLES) expect(isValidStyle(style)).toBe(true);
  });
  test('rejects an unknown style', () => {
    expect(isValidStyle('X')).toBe(false);
  });
});

describe('buildPreviewText', () => {
  const text = buildPreviewText(UNIX);

  test('renders every style as both a live token and a copyable literal', () => {
    for (const { style } of STYLES) {
      expect(text).toContain(`<t:${UNIX}:${style}>`);
      expect(text).toContain(`\`<t:${UNIX}:${style}>\``);
    }
  });

  test('includes the human-friendly style labels', () => {
    expect(text).toContain('Relative');
    expect(text).toContain('Long Date/Time');
  });
});

describe('customId round-trips', () => {
  test('post customId encodes unix and style', () => {
    expect(postCustomId(UNIX, 'R')).toBe(`ts_post:${UNIX}:R`);
    expect(parsePostCustomId(`ts_post:${UNIX}:R`)).toEqual({ unix: UNIX, style: 'R' });
  });

  test('post customId parse rejects malformed or invalid style', () => {
    expect(parsePostCustomId('ts_post:abc:F')).toBeNull();
    expect(parsePostCustomId(`ts_post:${UNIX}:Z`)).toBeNull();
    expect(parsePostCustomId('nope')).toBeNull();
  });

  test('style-select customId encodes unix', () => {
    expect(styleSelectCustomId(UNIX)).toBe(`ts_style:${UNIX}`);
    expect(parseStyleSelectCustomId(`ts_style:${UNIX}`)).toEqual({ unix: UNIX });
  });

  test('style-select parse rejects malformed', () => {
    expect(parseStyleSelectCustomId('ts_style:abc')).toBeNull();
  });
});

describe('buildComponents', () => {
  test('returns a style select and a post button', () => {
    const rows = buildComponents(UNIX, 'f').map((r) => r.toJSON());
    expect(rows).toHaveLength(2);

    const select = rows[0].components[0];
    expect(select.type).toBe(3); // string select
    expect(select.custom_id).toBe(`ts_style:${UNIX}`);
    expect(select.options).toHaveLength(STYLES.length);
    const defaulted = select.options.filter((o) => o.default);
    expect(defaulted).toHaveLength(1);
    expect(defaulted[0].value).toBe('f');

    const button = rows[1].components[0];
    expect(button.type).toBe(2); // button
    expect(button.custom_id).toBe(`ts_post:${UNIX}:f`);
    expect(button.label).toBe('Post to this channel');
  });

  test('defaults the selected style to F', () => {
    const rows = buildComponents(UNIX).map((r) => r.toJSON());
    expect(rows[1].components[0].custom_id).toBe(`ts_post:${UNIX}:F`);
    expect(rows[0].components[0].options.find((o) => o.default).value).toBe('F');
  });
});
