import { EmbedBuilder } from 'discord.js';

const VERSION_RE = /^v\d+$/i;

function splitCamelCase(s) {
  return s.replace(/([a-z])([A-Z])/g, '$1 $2');
}

function joinMapSegments(segments) {
  return segments.map(splitCamelCase).join(' ');
}

function formatTeam(raw) {
  if (!raw) return '-';
  return raw.split('+').map((s) => s.trim()).filter(Boolean).join(' + ') || '-';
}

export function prettifyLayerToken(line) {
  const parts = String(line).trim().split(/\s+/);
  const layerToken = parts[0] || '';
  const team1 = formatTeam(parts[1]);
  const team2 = formatTeam(parts[2]);

  const segments = layerToken.split('_');
  if (segments.length < 2) {
    return { map: layerToken, variant: '', team1, team2 };
  }

  const last = segments[segments.length - 1];
  let modeIdx, version;
  if (VERSION_RE.test(last)) {
    modeIdx = segments.length - 2;
    version = last;
  } else {
    modeIdx = segments.length - 1;
    version = '';
  }

  const mode = segments[modeIdx] || '';
  const map = joinMapSegments(segments.slice(0, modeIdx));
  const variant = version ? `${mode} ${version}` : mode;

  return { map, variant, team1, team2 };
}

function padRight(s, width) {
  return s + ' '.repeat(Math.max(0, width - s.length));
}

function padLeft(s, width) {
  return ' '.repeat(Math.max(0, width - s.length)) + s;
}

export function formatRotationTable(lines) {
  if (!lines || lines.length === 0) return '(empty rotation)';

  const rows = lines.map((line, idx) => {
    const parsed = prettifyLayerToken(line);
    return { idx: String(idx + 1), ...parsed };
  });

  const headers = { idx: '#', map: 'Map', variant: 'Variant', team1: 'Team 1', team2: 'Team 2' };
  const all = [headers, ...rows];

  const widths = {
    idx: Math.max(2, ...all.map((r) => r.idx.length)),
    map: Math.max(...all.map((r) => r.map.length)),
    variant: Math.max(...all.map((r) => r.variant.length)),
    team1: Math.max(...all.map((r) => r.team1.length)),
    team2: Math.max(...all.map((r) => r.team2.length)),
  };

  const fmt = (r) =>
    `${padLeft(r.idx, widths.idx)}  ` +
    `${padRight(r.map, widths.map)}  ` +
    `${padRight(r.variant, widths.variant)}  ` +
    `${padRight(r.team1, widths.team1)}  ` +
    `${padRight(r.team2, widths.team2)}`;

  return all.map(fmt).join('\n');
}

const COLOR_OK = 0x57F287;
const COLOR_ERR = 0xED4245;
const FOOTER = 'Validated via squadutils.org';

function modeLabel(mode) {
  if (mode === 'LayerList_Vote') return 'LayerList_Vote (players vote)';
  if (!mode) return 'Unknown';
  return mode;
}

export function buildSuccessEmbed({ mode, lines }) {
  const table = formatRotationTable(lines);
  const unix = Math.floor(Date.now() / 1000);
  const description =
    `Mode: ${modeLabel(mode)}  |  ${lines.length} layers  |  Updated <t:${unix}:R>\n` +
    '```\n' + table + '\n```';
  return new EmbedBuilder()
    .setColor(COLOR_OK)
    .setTitle('Royal Battalion - Layer Rotation')
    .setDescription(description)
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

export function buildErrorEmbed({ errors }) {
  const safeErrors = Array.isArray(errors) ? errors : [];
  const lines = safeErrors.map((e) => `Line ${e.line}: ${e.content} - ${e.error}`);
  const body = lines.length > 0 ? lines.join('\n') : 'No error detail returned.';
  const description = '```js\n' + (body.length > 3900 ? body.slice(0, 3900) + '\n... (truncated)' : body) + '\n```';
  return new EmbedBuilder()
    .setColor(COLOR_ERR)
    .setTitle('Layer rotation has errors')
    .setDescription(description)
    .setFooter({ text: FOOTER })
    .setTimestamp();
}
