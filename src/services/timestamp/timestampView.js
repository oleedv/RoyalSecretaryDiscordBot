import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';

/**
 * The Discord timestamp styles, in the order shown in the preview, each with a
 * human-friendly label. `<t:UNIX:style>` renders differently per viewer's locale.
 */
export const STYLES = [
  { style: 'F', label: 'Long Date/Time' },
  { style: 'f', label: 'Short Date/Time' },
  { style: 'D', label: 'Long Date' },
  { style: 'd', label: 'Short Date' },
  { style: 'T', label: 'Long Time' },
  { style: 't', label: 'Short Time' },
  { style: 'R', label: 'Relative' },
];

const VALID_STYLES = new Set(STYLES.map((s) => s.style));
const DEFAULT_STYLE = 'F';

export function isValidStyle(style) {
  return VALID_STYLES.has(style);
}

export function renderCode(unix, style) {
  return `<t:${unix}:${style}>`;
}

/**
 * Build the ephemeral preview body: one line per style showing the live-rendered
 * timestamp alongside its copyable literal code.
 */
export function buildPreviewText(unix) {
  const lines = STYLES.map(({ style, label }) => {
    const code = renderCode(unix, style);
    return `**${label}**: ${code}  ·  \`${code}\``;
  });
  return lines.join('\n');
}

export function postCustomId(unix, style) {
  return `ts_post:${unix}:${style}`;
}

export function parsePostCustomId(customId) {
  const m = /^ts_post:(\d+):([A-Za-z])$/.exec(customId ?? '');
  if (!m) return null;
  const style = m[2];
  if (!isValidStyle(style)) return null;
  return { unix: Number(m[1]), style };
}

export function styleSelectCustomId(unix) {
  return `ts_style:${unix}`;
}

export function parseStyleSelectCustomId(customId) {
  const m = /^ts_style:(\d+)$/.exec(customId ?? '');
  if (!m) return null;
  return { unix: Number(m[1]) };
}

/**
 * Build the two component rows for the ephemeral reply: a style select (whose
 * default reflects `selectedStyle`) and a "Post to this channel" button (whose
 * customId carries the currently selected style).
 */
export function buildComponents(unix, selectedStyle = DEFAULT_STYLE) {
  const style = isValidStyle(selectedStyle) ? selectedStyle : DEFAULT_STYLE;

  const select = new StringSelectMenuBuilder()
    .setCustomId(styleSelectCustomId(unix))
    .setPlaceholder('Style to post')
    .addOptions(
      STYLES.map(({ style: s, label }) => ({
        label,
        value: s,
        default: s === style,
      }))
    );

  const postButton = new ButtonBuilder()
    .setCustomId(postCustomId(unix, style))
    .setLabel('Post to this channel')
    .setStyle(ButtonStyle.Primary);

  return [
    new ActionRowBuilder().addComponents(select),
    new ActionRowBuilder().addComponents(postButton),
  ];
}
