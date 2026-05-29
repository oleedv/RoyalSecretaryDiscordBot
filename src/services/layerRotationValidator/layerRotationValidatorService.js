const MODE_LINE = /^\s*MapRotationMode\s*=\s*(\S+)\s*$/;
const COMMENT_PREFIX = /^\s*(\/\/|#)/;

export function parseMapRotationMode(cfgText) {
  if (!cfgText) return null;
  const lines = cfgText.split(/\r?\n/);
  for (const line of lines) {
    if (COMMENT_PREFIX.test(line)) continue;
    const m = line.match(MODE_LINE);
    if (m) return m[1];
  }
  return null;
}
