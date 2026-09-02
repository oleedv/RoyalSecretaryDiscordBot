import { query } from '../database/connection.js';
import { generateId } from '../utils/id.js';
import { validateCountry } from '../utils/countries.js';
import logger from '../logger.js';

const log = logger.child({ module: 'userService' });

const DOB_RE = /^(\d{2})[-/](\d{2})[-/](\d{4})$/;
const STEAM64_RE = /^\d{17}$/;

export function parseProspectDateOfBirth(raw) {
  if (!raw) return null;
  const match = String(raw).trim().match(DOB_RE);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

export function parseProspectSteamId(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (trimmed.toUpperCase() === 'Q') return null;
  if (!STEAM64_RE.test(trimmed)) return null;
  return trimmed;
}

function sqlDateTime(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  return value.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Copy prospect application fields onto the website User row.
 * Fills only empty columns so staff edits are not overwritten.
 */
export async function applyProspectProfile(discordId, prospect, extras = {}) {
  if (!discordId || !prospect) return;

  const countryResult = prospect.nationality ? validateCountry(prospect.nationality) : { valid: false };
  const country = countryResult.valid ? countryResult.country : null;
  const dateOfBirth = parseProspectDateOfBirth(prospect.date_of_birth ?? prospect.dateOfBirth);
  const steamId = parseProspectSteamId(prospect.steam_id ?? prospect.steamId);
  const accepted = prospect.status === 'accepted';
  let membershipDate = null;
  if (accepted) {
    const parsed = prospect.closed_at ? new Date(prospect.closed_at) : new Date();
    membershipDate = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }

  try {
    const existing = await query(
      'SELECT id, country, dateOfBirth, membershipDate, steamId FROM User WHERE discordId = ?',
      [discordId],
      'website',
    );
    const row = existing[0];
    if (row) {
      const sets = [];
      const params = [];
      if (!row.country && country) {
        sets.push('country = ?');
        params.push(country);
      }
      if (!row.dateOfBirth && dateOfBirth) {
        sets.push('dateOfBirth = ?');
        params.push(sqlDateTime(dateOfBirth));
      }
      if (!row.membershipDate && membershipDate) {
        sets.push('membershipDate = ?');
        params.push(sqlDateTime(membershipDate));
      }
      if (!row.steamId && steamId) {
        sets.push('steamId = ?');
        params.push(steamId);
      }
      if (sets.length === 0) return;
      params.push(discordId);
      await query(
        `UPDATE User SET ${sets.join(', ')}, updatedAt = NOW() WHERE discordId = ?`,
        params,
        'website',
      );
      return;
    }

    await query(
      `INSERT INTO User (id, discordId, discordName, country, dateOfBirth, membershipDate, steamId, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        generateId(),
        discordId,
        extras.discordName || discordId,
        country,
        sqlDateTime(dateOfBirth),
        sqlDateTime(membershipDate),
        steamId,
      ],
      'website',
    );
  } catch (err) {
    log.warn({ err, discordId }, 'Could not copy prospect profile to website user');
  }
}

export async function getStoredSteamId(discordId) {
  try {
    const rows = await query('SELECT steamId FROM User WHERE discordId = ?', [discordId], 'website');
    return rows[0]?.steamId || null;
  } catch (err) {
    log.warn({ err, discordId }, 'Failed to fetch stored Steam ID');
    return null;
  }
}

export async function getDiscordIdBySteamId(steamId) {
  try {
    const rows = await query('SELECT discordId FROM User WHERE steamId = ?', [steamId], 'website');
    return rows[0]?.discordId || null;
  } catch (err) {
    log.warn({ err, steamId }, 'Failed to fetch Discord ID by Steam ID');
    return null;
  }
}

export async function linkSteamId(discordId, steamId, discordName) {
  if (!steamId || steamId.toUpperCase() === 'Q') return;
  try {
    await query(
      `INSERT INTO User (id, discordId, discordName, steamId, updatedAt)
       VALUES (?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE steamId = IF(steamId IS NULL, VALUES(steamId), steamId), updatedAt = NOW()`,
      [generateId(), discordId, discordName || discordId, steamId],
      'website'
    );
  } catch (err) {
    log.warn({ err, discordId }, 'Could not link Steam ID to website user');
  }
}
