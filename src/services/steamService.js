import { createEmbed } from '../utils/embed.js';
import config from '../config.js';
import logger from '../logger.js';

const log = logger.child({ module: 'steam' });

const STEAM_API_BASE = 'https://api.steampowered.com';

export function isConfigured() {
  return !!config.steam?.apiKey;
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
    };
  } catch (err) {
    log.warn({ err: err.message, steamId }, 'Steam: profile fetch failed');
    return null;
  }
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

export function buildSteamEmbed(steamId) {
  return createEmbed('Ticket')
    .setTitle('Player Lookup')
    .setColor(0x1b2838)
    .addFields(
      { name: 'Steam ID', value: steamId, inline: true },
      {
        name: 'Links',
        value: [
          `[steamid.com](https://www.steamid.com/lookup/${steamId})`,
          `[BattleMetrics](https://www.battlemetrics.com/rcon/players?filter[search]=${steamId})`,
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
          `[steamid.com](https://www.steamid.com/lookup/${vanityUrl})`,
          `[CBL](https://communitybanlist.com/search/${vanityUrl})`,
        ].join(' | '),
      }
    );
}
