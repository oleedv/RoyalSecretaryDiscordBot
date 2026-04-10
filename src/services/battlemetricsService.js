import config from '../config.js';
import logger from '../logger.js';
import { query } from '../database/connection.js';

const log = logger.child({ module: 'battlemetrics' });

const BASE_URL = 'https://api.battlemetrics.com';
const playerIdCache = new Map();

function headers() {
  return {
    Authorization: `Bearer ${config.battlemetrics.token}`,
    'Content-Type': 'application/json',
  };
}

export function isConfigured() {
  return !!config.battlemetrics.token;
}

export async function playerSearch(steamId) {
  if (!isConfigured()) return null;

  // Tier 1: in-memory cache
  const cached = playerIdCache.get(steamId);
  if (cached) return cached;

  // Tier 2: database cache
  try {
    const rows = await query('SELECT bm_player_id, bm_player_name FROM bm_players WHERE steam_id = ?', [steamId]);
    if (rows.length > 0) {
      const result = { playerId: rows[0].bm_player_id, playerName: rows[0].bm_player_name };
      playerIdCache.set(steamId, result);
      return result;
    }
  } catch (err) {
    log.warn({ err, steamId }, 'BM: db cache lookup failed');
  }

  // Tier 3: BM API
  try {
    log.info({ steamId }, 'BM: searching player');
    const orgId = config.battlemetrics.organisationId;
    const url = `${BASE_URL}/players?filter[search]=${steamId}&filter[organization]=${orgId}`;
    const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      log.warn({ steamId, status: res.status }, 'BM: player search returned non-OK status');
      return null;
    }
    const json = await res.json();
    const player = json?.data?.[0];
    if (!player) {
      log.warn({ steamId }, 'BM: no player found');
      return null;
    }
    const result = { playerId: player.id, playerName: player.attributes.name };
    playerIdCache.set(steamId, result);
    query(
      'INSERT INTO bm_players (steam_id, bm_player_id, bm_player_name) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE bm_player_name = VALUES(bm_player_name)',
      [steamId, result.playerId, result.playerName]
    ).catch((err) => log.warn({ err, steamId }, 'BM: db cache write failed'));
    return result;
  } catch (err) {
    log.warn({ err, steamId }, 'BM: player search failed');
    return null;
  }
}

export async function resolvePlayerId(steamId) {
  if (!isConfigured()) return null;
  const result = await playerSearch(steamId);
  return result?.playerId ?? null;
}

export async function getTimePlayed(playerId, startDate, endDate) {
  if (!isConfigured()) return null;
  try {
    const serverId = config.battlemetrics.serverId;
    log.info({ playerId, serverId, startDate, endDate }, 'BM: fetching time played');
    const url = `${BASE_URL}/players/${playerId}/time-played-history/${serverId}?start=${startDate}T00:00:00Z&stop=${endDate}T00:00:00Z`;
    const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      log.warn({ playerId, status: res.status }, 'BM: time played returned non-OK status');
      return null;
    }
    const json = await res.json();
    const totalSeconds = (json?.data ?? []).reduce((sum, entry) => sum + (entry.attributes?.value ?? 0), 0);
    return Math.round((totalSeconds / 3600) * 10) / 10;
  } catch (err) {
    log.warn({ err, playerId }, 'BM: time played fetch failed');
    return null;
  }
}

export async function getPlayerCounters(playerId) {
  if (!isConfigured()) return {};
  try {
    log.info({ playerId }, 'BM: fetching player counters');
    const url = `${BASE_URL}/players/${playerId}?include=playerCounter`;
    const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      log.warn({ playerId, status: res.status }, 'BM: player counters returned non-OK status');
      return {};
    }
    const json = await res.json();
    const counters = {};
    for (const item of json?.included ?? []) {
      if (item.type === 'playerCounter') {
        counters[item.attributes.name] = item.attributes.value;
      }
    }
    return counters;
  } catch (err) {
    log.warn({ err, playerId }, 'BM: player counters fetch failed');
    return {};
  }
}

export async function addFlag(steamId, flagId) {
  if (!isConfigured()) return null;
  try {
    const result = await playerSearch(steamId);
    if (!result) return null;
    log.info({ steamId, playerId: result.playerId, flagId }, 'BM: adding flag');
    const url = `${BASE_URL}/players/${result.playerId}/relationships/flags`;
    const res = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ data: [{ type: 'playerFlag', id: flagId }] }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      log.warn({ steamId, flagId, status: res.status }, 'BM: add flag returned non-OK status');
      return null;
    }
    return true;
  } catch (err) {
    log.warn({ err, steamId, flagId }, 'BM: add flag failed');
    return null;
  }
}

export async function removeFlag(steamId, flagId) {
  if (!isConfigured()) return null;
  try {
    const result = await playerSearch(steamId);
    if (!result) return null;
    log.info({ steamId, playerId: result.playerId, flagId }, 'BM: removing flag');
    const url = `${BASE_URL}/players/${result.playerId}/relationships/flags`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: headers(),
      body: JSON.stringify({ data: [{ type: 'playerFlag', id: flagId }] }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      log.warn({ steamId, flagId, status: res.status }, 'BM: remove flag returned non-OK status');
      return null;
    }
    return true;
  } catch (err) {
    log.warn({ err, steamId, flagId }, 'BM: remove flag failed');
    return null;
  }
}

export async function getPlayerBans(steamId) {
  if (!isConfigured()) return null;
  try {
    const result = await playerSearch(steamId);
    if (!result) return null;
    const { playerId } = result;
    log.info({ steamId, playerId }, 'BM: fetching player bans');
    const url = `${BASE_URL}/bans?filter[player]=${playerId}&include=server&page[size]=40`;
    const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      log.warn({ steamId, status: res.status }, 'BM: player bans returned non-OK status');
      return null;
    }
    const json = await res.json();

    const servers = new Map();
    for (const inc of json?.included ?? []) {
      if (inc.type === 'server') {
        servers.set(inc.id, inc.attributes?.name || 'Unknown Server');
      }
    }

    const activeBans = [];
    let expiredBanCount = 0;

    for (const ban of json?.data ?? []) {
      const attrs = ban.attributes || {};
      const expires = attrs.expires;
      const isExpired = expires && new Date(expires) < new Date();

      if (isExpired) {
        expiredBanCount++;
        continue;
      }

      const serverId = ban.relationships?.server?.data?.id;
      activeBans.push({
        reason: attrs.reason || 'No reason',
        created: attrs.timestamp || null,
        expires: expires || null,
        permanent: !expires,
        serverName: serverId ? (servers.get(serverId) || 'Unknown Server') : 'All Servers',
      });
    }

    activeBans.sort((a, b) => new Date(b.created) - new Date(a.created));

    return { activeBans, expiredBanCount };
  } catch (err) {
    log.warn({ err, steamId }, 'BM: player bans fetch failed');
    return null;
  }
}

export async function getPlayerNotes(steamId) {
  if (!isConfigured()) return null;
  try {
    const result = await playerSearch(steamId);
    if (!result) return null;
    const { playerId } = result;
    log.info({ steamId, playerId }, 'BM: fetching player notes');
    const url = `${BASE_URL}/players/${playerId}?include=playerNote`;
    const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      log.warn({ steamId, status: res.status }, 'BM: player notes returned non-OK status');
      return null;
    }
    const json = await res.json();
    const notes = [];
    for (const item of json?.included ?? []) {
      if (item.type === 'playerNote') {
        notes.push({
          note: item.attributes?.note || '',
          createdAt: item.attributes?.createdAt || null,
        });
      }
    }
    notes.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return notes;
  } catch (err) {
    log.warn({ err, steamId }, 'BM: player notes fetch failed');
    return null;
  }
}

export async function resolveAndGetStats(steamId, startDate, endDate) {
  if (!isConfigured()) return null;
  try {
    const result = await playerSearch(steamId);
    if (!result) return null;
    const { playerId, playerName } = result;
    const [hours, counters] = await Promise.all([
      getTimePlayed(playerId, startDate, endDate),
      getPlayerCounters(playerId),
    ]);
    return { playerName, playerId, hours, counters };
  } catch (err) {
    log.warn({ err, steamId }, 'BM: resolveAndGetStats failed');
    return null;
  }
}
