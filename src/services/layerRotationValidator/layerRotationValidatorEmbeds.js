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

function compactTeam(team) {
  return team.replace(/ \+ /g, '+');
}

function formatRow(line, idx) {
  const { map, variant, team1, team2 } = prettifyLayerToken(line);
  const layer = variant ? `${map} ${variant}` : map;
  const t1 = compactTeam(team1);
  const t2 = compactTeam(team2);
  let teams;
  if (t1 !== '-' && t2 !== '-') teams = ` - *${t1} vs ${t2}*`;
  else if (t1 !== '-') teams = ` - *${t1}*`;
  else if (t2 !== '-') teams = ` - *${t2}*`;
  else teams = '';
  return `**${idx + 1}.** ${layer}${teams}`;
}

export function formatRotationList(lines) {
  if (!lines || lines.length === 0) return '(empty rotation)';
  return lines.map(formatRow).join('\n');
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
  const list = formatRotationList(lines);
  const unix = Math.floor(Date.now() / 1000);
  const description =
    `Mode: ${modeLabel(mode)}\n` +
    `Updated <t:${unix}:R>\n\n` +
    list;
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
