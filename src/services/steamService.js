import { createEmbed } from '../utils/embed.js';
import { query } from '../database/connection.js';
import config from '../config.js';
import logger from '../logger.js';

const log = logger.child({ module: 'steam' });

const STEAM_API_BASE = 'https://api.steampowered.com';
const AVATAR_CDN_BASE = 'https://avatars.steamstatic.com';
const DAY_MS = 86400000;
export const AVATAR_REFRESH_DAYS = 30;

export function isConfigured() {
  return !!config.steam?.apiKey;
}

/** Reconstruct the full-size avatar url from a Steam avatar hash. */
export function buildAvatarUrl(hash) {
  return hash ? `${AVATAR_CDN_BASE}/${hash}_full.jpg` : null;
}

/** True if a cached avatar was last checked within the refresh window. */
export function isAvatarFresh(lastCheckedAt, nowMs, refreshDays = AVATAR_REFRESH_DAYS) {
  if (!lastCheckedAt) return false;
  return (nowMs - new Date(lastCheckedAt).getTime()) < refreshDays * DAY_MS;
}

export async function getSteamProfile(steamId) {
  if (!isConfigured()) return null;
  try {
    const url = `${STEAM_API_BASE}/ISteamUser/GetPlayerSummaries/v0002/?key=${config.steam.apiKey}&steamids=${steamId}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      log.warn({ steamId, status: res.status }, 'Steam: profile fetch returned non-OK status');
      return null;
    }
    const json = await res.json();
    const player = json?.response?.players?.[0];
    if (!player) return null;
    return {
      personaName: player.personaname || null,
      profileUrl: player.profileurl || null,
      visibility: player.communityvisibilitystate === 3 ? 'public' : 'private',
      accountCreated: player.timecreated ? new Date(player.timecreated * 1000).toISOString().slice(0, 10) : null,
      avatarHash: player.avatarhash || null,
    };
  } catch (err) {
    log.warn({ err: err.message, steamId }, 'Steam: profile fetch failed');
    return null;
  }
}

async function getCachedAvatar(steamId) {
  const rows = await query(
    'SELECT avatar_hash AS avatarHash, last_checked_at AS lastCheckedAt FROM steam_avatar_cache WHERE steam_id = ? LIMIT 1',
    [steamId]
  );
  return rows[0] || null;
}

async function upsertCachedAvatar(steamId, hash) {
  await query(
    `INSERT INTO steam_avatar_cache (steam_id, avatar_hash) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE avatar_hash = VALUES(avatar_hash), last_checked_at = NOW()`,
    [steamId, hash]
  );
}

/**
 * Resolve a player's avatar url, cached by hash in steam_avatar_cache.
 * Fresh hit -> no API call. Stale/miss -> refresh from API + upsert.
 * API failure with a stale row -> serve the stale url. Otherwise null.
 */
export async function getAvatarUrl(steamId) {
  let cached = null;
  try {
    cached = await getCachedAvatar(steamId);
  } catch (err) {
    log.warn({ err: err.message, steamId }, 'Steam: avatar cache read failed');
  }

  if (cached && isAvatarFresh(cached.lastCheckedAt, Date.now())) {
    return buildAvatarUrl(cached.avatarHash);
  }

  const profile = await getSteamProfile(steamId);
  if (profile?.avatarHash) {
    try {
      await upsertCachedAvatar(steamId, profile.avatarHash);
    } catch (err) {
      log.warn({ err: err.message, steamId }, 'Steam: avatar cache write failed');
    }
    return buildAvatarUrl(profile.avatarHash);
  }

  if (cached?.avatarHash) return buildAvatarUrl(cached.avatarHash);
  return null;
}

export async function getSteamBans(steamId) {
  if (!isConfigured()) return null;
  try {
    const url = `${STEAM_API_BASE}/ISteamUser/GetPlayerBans/v1/?key=${config.steam.apiKey}&steamids=${steamId}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      log.warn({ steamId, status: res.status }, 'Steam: bans fetch returned non-OK status');
      return null;
    }
    const json = await res.json();
    const player = json?.players?.[0];
    if (!player) return null;
    return {
      vacBanned: player.VACBanned || false,
      numberOfVacBans: player.NumberOfVACBans || 0,
      daysSinceLastBan: player.DaysSinceLastBan || 0,
      numberOfGameBans: player.NumberOfGameBans || 0,
      communityBanned: player.CommunityBanned || false,
      economyBan: player.EconomyBan || 'none',
    };
  } catch (err) {
    log.warn({ err: err.message, steamId }, 'Steam: bans fetch failed');
    return null;
  }
}

const STEAM64_REGEX = /\b(7656119\d{10})\b/g;
const STEAM_PROFILE_URL_REGEX = /steamcommunity\.com\/profiles\/(7656119\d{10})/g;
const STEAM_VANITY_URL_REGEX = /steamcommunity\.com\/id\/([a-zA-Z0-9_-]+)/g;

/**
 * Validate and extract a Steam64 ID from user input.
 * Accepts: raw Steam64 ID, Steam profile URL, or "Q" (testing shorthand).
 * Returns { valid: true, steamId } or { valid: false, reason }.
 */
export function validateSteamInput(input) {
  if (!input) return { valid: false, reason: 'Steam ID is required.' };

  const trimmed = input.trim();

  // Allow "Q" as a special-case valid input (non-production only)
  if (trimmed.toUpperCase() === 'Q' && process.env.NODE_ENV !== 'production') return { valid: true, steamId: trimmed };

  // Try extracting from profile URL
  const profileMatch = trimmed.match(/steamcommunity\.com\/profiles\/(7656119\d{10})/);
  if (profileMatch) return { valid: true, steamId: profileMatch[1] };

  // Try raw Steam64 ID
  const rawMatch = trimmed.match(/^(7656119\d{10})$/);
  if (rawMatch) return { valid: true, steamId: rawMatch[1] };

  return { valid: false, reason: 'Invalid Steam ID. Please provide a valid Steam64 ID (e.g. 76561198012345678) or a Steam profile URL.' };
}

export function detectSteamIds(text) {
  const ids = new Set();

  for (const match of text.matchAll(STEAM64_REGEX)) {
    ids.add(match[1]);
  }
  for (const match of text.matchAll(STEAM_PROFILE_URL_REGEX)) {
    ids.add(match[1]);
  }

  const vanityMatches = [...text.matchAll(STEAM_VANITY_URL_REGEX)];
  const vanityUrls = vanityMatches.map((m) => m[1]);

  return { steamIds: [...ids], vanityUrls };
}

export function buildSteamEmbed(steamId, bmPlayerId = null) {
  return createEmbed('Ticket')
    .setTitle('Player Lookup')
    .setColor(0x1b2838)
    .addFields(
      { name: 'Steam ID', value: steamId, inline: true },
      {
        name: 'Links',
        value: [
          `[steamid.com](https://www.steamid.com/profiles/${steamId})`,
          `[BattleMetrics](${bmPlayerId ? `https://www.battlemetrics.com/rcon/players/${bmPlayerId}` : `https://www.battlemetrics.com/rcon/players?filter[search]=${steamId}`})`,
          `[CBL](https://communitybanlist.com/search/${steamId})`,
        ].join(' | '),
      }
    );
}

export function buildVanityEmbed(vanityUrl) {
  return createEmbed('Ticket')
    .setTitle('Player Lookup')
    .setColor(0x1b2838)
    .addFields(
      { name: 'Vanity URL', value: vanityUrl, inline: true },
      {
        name: 'Links',
        value: [
          `[steamid.com](https://www.steamid.com/profiles/${vanityUrl})`,
          `[CBL](https://communitybanlist.com/search/${vanityUrl})`,
        ].join(' | '),
      }
    );
}
