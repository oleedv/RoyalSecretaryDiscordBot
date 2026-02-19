import { createEmbed } from '../utils/embed.js';

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

  // Allow "Q" as a special-case valid input
  if (trimmed.toUpperCase() === 'Q') return { valid: true, steamId: trimmed };

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
    .setTitle('Steam Profile Detected')
    .setColor(0x1b2838)
    .addFields(
      { name: 'Steam ID', value: steamId, inline: true },
      {
        name: 'Links',
        value: [
          `[steamid.io](https://steamid.io/lookup/${steamId})`,
          `[BattleMetrics](https://www.battlemetrics.com/rcon/players?filter[search]=${steamId})`,
        ].join(' | '),
      }
    );
}

export function buildVanityEmbed(vanityUrl) {
  return createEmbed('Ticket')
    .setTitle('Steam Profile Detected')
    .setColor(0x1b2838)
    .addFields(
      { name: 'Vanity URL', value: vanityUrl, inline: true },
      {
        name: 'Links',
        value: `[steamid.io](https://steamid.io/lookup/${vanityUrl})`,
      }
    );
}
