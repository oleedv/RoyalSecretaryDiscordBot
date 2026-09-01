// Parses the SQUADJS_SERVERS env string. Format per entry: name|url|token|serverId
// (serverId is the canonical squadjs_servers.id). Comma-separated for multiple servers.
// SQUADJS_DISABLED is a comma-separated list of connection names to skip
// (e.g. "staging" while that env is down) so reconnect loops do not spam logs.
export function parseDisabledSquadJsNames(disabledStr = process.env.SQUADJS_DISABLED) {
  return new Set(
    (disabledStr || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function parseSquadJsServers(envStr, disabledStr = process.env.SQUADJS_DISABLED) {
  if (!envStr) return [];
  const disabled = parseDisabledSquadJsNames(disabledStr);
  return envStr.split(',').map((entry) => {
    const [name, url, token, serverIdRaw] = entry.trim().split('|');
    const parsed = serverIdRaw != null && serverIdRaw.trim() !== '' ? Number(serverIdRaw) : null;
    const serverId = Number.isFinite(parsed) ? parsed : null;
    return { name, url, token, serverId };
  }).filter((s) => !disabled.has((s.name || '').toLowerCase()));
}
