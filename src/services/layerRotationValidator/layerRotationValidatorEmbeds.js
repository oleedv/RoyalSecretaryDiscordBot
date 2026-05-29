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
