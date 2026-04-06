const SENSITIVE_PATTERN = /^([^=]*(?:password|token|secret|rcon|key|pass)[^=]*)=(.+)$/i;

export function maskSensitiveValues(lines) {
  let maskCount = 0;
  const masked = lines.map((line) => {
    const match = line.match(SENSITIVE_PATTERN);
    if (match) {
      maskCount++;
      return `${match[1]}=********`;
    }
    return line;
  });
  return { masked, maskCount };
}
