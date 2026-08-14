import config from '../../config.js';
import logger from '../../logger.js';
import { query } from '../../database/connection.js';
import { getAllServerStates, extractGameMode } from '../seeding/seedingSocket.js';
import { getSeedingConfig } from '../seeding/seedingService.js';
import { getServerStats } from './serverStatusQueries.js';
import { buildQuickStatusEmbed, buildMissingDiscordEmbed } from './quickStatusEmbeds.js';
import {
  classifyOnlinePlayers,
  isMemberRole,
  isProspectRole,
  normalizeRole,
} from './quickStatusRoles.js';
import { reportError } from '../admin/errorAlertService.js';

const log = logger.child({ module: 'quickStatus' });

let updateInterval = null;
let messageId = null;
let lastSuccessfulUpdate = Date.now();
let lastEmptyWarn = 0;
let lastStaleWarn = 0;
const THROTTLE_MS = 5 * 60 * 1000;

/**
 * Resolve which SquadJS connection feeds the quick-status embed.
 * Prefer explicit quickStatus.serverId / serverName, then seeding.seedingServer, then first.
 */
function pickServerEntry() {
  const all = getAllServerStates();
  if (!all.length) return null;

  const qs = config.quickStatus || {};
  if (qs.serverId != null && qs.serverId !== '') {
    const id = Number(qs.serverId);
    const hit = all.find((s) => s.serverId != null && Number(s.serverId) === id);
    if (hit) return hit;
  }
  if (qs.serverName) {
    const hit = all.find((s) => s.name === qs.serverName);
    if (hit) return hit;
  }
  const preferred = config.seeding?.seedingServer;
  if (preferred) {
    const hit = all.find((s) => s.name === preferred);
    if (hit) return hit;
  }
  return all[0];
}

/**
 * Load active whitelist entries for the given steam IDs.
 * @returns {Map<string, Array<{ role: string, name?: string }>>}
 */
async function loadWhitelistBySteamIds(steamIds) {
  const map = new Map();
  if (!steamIds.length) return map;

  // Chunk to keep IN lists reasonable
  const CHUNK = 100;
  for (let i = 0; i < steamIds.length; i += CHUNK) {
    const chunk = steamIds.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    try {
      const rows = await query(
        `SELECT steamId, role, name
         FROM WhitelistEntry
         WHERE steamId IN (${placeholders})
           AND (expiresAt IS NULL OR expiresAt > NOW())`,
        chunk,
        'website'
      );
      for (const row of rows) {
        const id = String(row.steamId);
        if (!map.has(id)) map.set(id, []);
        map.get(id).push({ role: row.role, name: row.name });
      }
    } catch (err) {
      log.error({ err }, 'Failed to load whitelist entries for quick status');
    }
  }
  return map;
}

/**
 * Discord IDs currently in a non-AFK voice channel in the configured guild.
 * @returns {{ voiceSet: Set<string>, voiceCount: number }}
 */
async function getVoicePresence(client) {
  const voiceSet = new Set();
  try {
    const guildId = config.guild?.id;
    if (!guildId) return { voiceSet, voiceCount: 0 };
    const guild = await client.guilds.fetch(guildId);
    const afkId = config.commsWatch?.afkChannelId || guild.afkChannelId || null;
    for (const vs of guild.voiceStates.cache.values()) {
      if (vs.channelId && vs.channelId !== afkId) voiceSet.add(String(vs.id));
    }
  } catch (err) {
    log.warn({ err }, 'Failed to read voice states for quick status');
  }
  return { voiceSet, voiceCount: voiceSet.size };
}

/**
 * Map steamId -> discordId from website User table (batched).
 * @returns {Map<string, string>}
 */
async function loadDiscordIdsBySteamIds(steamIds) {
  const map = new Map();
  if (!steamIds.length) return map;
  const CHUNK = 100;
  for (let i = 0; i < steamIds.length; i += CHUNK) {
    const chunk = steamIds.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    try {
      const rows = await query(
        `SELECT steamId, discordId FROM User
         WHERE steamId IN (${placeholders}) AND discordId IS NOT NULL AND discordId <> ''`,
        chunk,
        'website'
      );
      for (const row of rows) {
        if (row.steamId && row.discordId) map.set(String(row.steamId), String(row.discordId));
      }
    } catch (err) {
      log.warn({ err }, 'Failed to load Discord IDs for quick status');
    }
  }
  return map;
}

/**
 * RB members + prospects in-game who are not currently in Discord voice.
 */
function findMissingFromDiscord(players, wlMap, discordBySteam, voiceSet) {
  const missing = [];
  for (const p of players || []) {
    const steamId = String(p.steamID || p.steamId || '');
    if (!steamId) continue;
    const entries = wlMap.get(steamId) || [];
    let kind = null;
    for (const e of entries) {
      const role = normalizeRole(e.role);
      if (isProspectRole(role)) { kind = 'prospect'; break; }
      if (isMemberRole(role)) kind = 'member';
    }
    if (!kind) continue;

    const discordId = discordBySteam.get(steamId) || null;
    if (discordId && voiceSet.has(String(discordId))) continue;

    missing.push({
      name: p.name || entries[0]?.name || 'Unknown',
      steamId,
      discordId,
      kind,
    });
  }
  missing.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return missing;
}

async function findExistingMessage(channel, client) {
  const messages = await channel.messages.fetch({ limit: 20 });
  const botEmbeds = messages
    .filter((msg) => msg.author.id === client.user.id && msg.embeds.length > 0)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  return botEmbeds.first() || null;
}

async function ensureMessage(channel, client, embeds) {
  if (messageId) {
    const existing = await channel.messages.fetch(messageId).catch(() => null);
    if (existing) return existing;
    messageId = null;
  }

  const found = await findExistingMessage(channel, client);
  if (found) {
    messageId = found.id;
    log.info({ messageId }, 'Found existing quick-status message');
    return found;
  }

  const msg = await channel.send({ embeds });
  messageId = msg.id;
  log.info({ messageId }, 'Created quick-status message');
  return msg;
}

async function updateOnce(channel, client) {
  try {
    const entry = pickServerEntry();
    if (!entry) {
      const now = Date.now();
      if (now - lastEmptyWarn >= THROTTLE_MS) {
        lastEmptyWarn = now;
        log.warn('No SquadJS server states — quick status not updating');
      }
      return;
    }

    const { name, serverId, state } = entry;
    const seedCfg = await getSeedingConfig();
    const threshold = seedCfg?.seed_threshold ?? config.seeding?.defaultThreshold ?? 40;

    const steamIds = (state.players || [])
      .map((p) => String(p.steamID || p.steamId || ''))
      .filter(Boolean);

    const [wlMap, serverStats, voice, discordBySteam] = await Promise.all([
      loadWhitelistBySteamIds(steamIds),
      state.connected
        ? getServerStats(name, serverId, state.serverName ? [state.serverName] : [])
        : Promise.resolve({}),
      getVoicePresence(client),
      loadDiscordIdsBySteamIds(steamIds),
    ]);

    const roles = classifyOnlinePlayers(state.players || [], wlMap);
    const missing = findMissingFromDiscord(
      state.players || [],
      wlMap,
      discordBySteam,
      voice.voiceSet,
    );
    const isSeeding = (extractGameMode(state.currentLayer) || '').toLowerCase() === 'seed';

    const mainEmbed = buildQuickStatusEmbed(state, threshold, roles, serverStats, {
      voiceCount: voice.voiceCount,
    });
    // Always keep the second embed so the message shape stays stable (old widget behaviour).
    const missingEmbed = buildMissingDiscordEmbed(missing, { isSeeding });
    const embeds = [mainEmbed, missingEmbed];

    const msg = await ensureMessage(channel, client, embeds);
    await msg.edit({ embeds });
    lastSuccessfulUpdate = Date.now();
  } catch (err) {
    log.error({ err }, 'Failed to update quick status');
    reportError(err, { source: 'scheduler:quickStatus:update' }).catch(() => {});
  }

  const staleDuration = Date.now() - lastSuccessfulUpdate;
  if (staleDuration > THROTTLE_MS) {
    const now = Date.now();
    if (now - lastStaleWarn >= THROTTLE_MS) {
      lastStaleWarn = now;
      log.warn(
        { staleMinutes: Math.round(staleDuration / 60_000) },
        'Quick status embed has not been successfully updated'
      );
    }
  }
}

export async function startQuickStatusUpdater(client) {
  const channelId = config.quickStatus?.channelId;
  if (!channelId) {
    log.warn('No quickStatus.channelId configured — skipping quick status updater');
    return;
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    log.warn({ channelId }, 'Quick status channel not found');
    return;
  }

  // First paint (may be empty state until SquadJS connects)
  await updateOnce(channel, client);

  const intervalMs = config.quickStatus?.updateIntervalMs ?? 60_000;
  if (updateInterval) clearInterval(updateInterval);
  updateInterval = setInterval(() => updateOnce(channel, client), intervalMs);
  log.info({ channelId, intervalMs }, 'Quick status updater started');
}

export function stopQuickStatusUpdater() {
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
  }
  messageId = null;
  log.info('Quick status updater stopped');
}

/** Force-delete tracked/bot embeds and restart (used by /refresh-panels). */
export async function refreshQuickStatus(client) {
  const channelId = config.quickStatus?.channelId;
  if (!channelId) return 'Quick Status: skipped (no channel configured)';

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return 'Quick Status: skipped (channel not found)';

  const messages = await channel.messages.fetch({ limit: 20 });
  const botEmbeds = messages.filter(
    (msg) => msg.author.id === client.user.id && msg.embeds.length > 0
  );
  for (const msg of botEmbeds.values()) {
    await msg.delete().catch(() => {});
  }

  stopQuickStatusUpdater();
  await startQuickStatusUpdater(client);
  return `Quick Status: refreshed (${botEmbeds.size} message(s) replaced)`;
}
