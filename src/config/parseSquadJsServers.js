// Parses the SQUADJS_SERVERS env string. Format per entry: name|url|token|serverId
// (serverId is the canonical squadjs_servers.id). Comma-separated for multiple servers.
export function parseSquadJsServers(envStr) {
  if (!envStr) return [];
  return envStr.split(',').map((entry) => {
    const [name, url, token, serverIdRaw] = entry.trim().split('|');
    const parsed = serverIdRaw != null && serverIdRaw.trim() !== '' ? Number(serverIdRaw) : null;
    const serverId = Number.isFinite(parsed) ? parsed : null;
    return { name, url, token, serverId };
  });
}
