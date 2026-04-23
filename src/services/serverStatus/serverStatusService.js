import config from '../../config.js';
import logger from '../../logger.js';
import { query } from '../../database/connection.js';
import { getAllServerStates } from '../seeding/seedingSocket.js';
import { getSeedingConfig } from '../seeding/seedingService.js';
import { buildServerStatusEmbed } from './serverStatusEmbeds.js';
import { getServerStats } from './serverStatusQueries.js';
import { reportError } from '../admin/errorAlertService.js';

const log = logger.child({ module: 'serverStatus' });

let updateInterval = null;
const statusMessages = []; // [{ name, messageId }]

let lastSuccessfulUpdate = Date.now();
let lastEmptyStatesWarn = 0;
let lastNameMismatchWarn = 0;
let lastStaleWarn = 0;
const THROTTLE_MS = 5 * 60 * 1000; // 5 minutes

// Stored references for self-recovery
let _channel = null;
let _client = null;

// Cached RB member steam IDs
let rbSteamIds = new Set();

async function refreshRBMembers() {
  try {
    const rows = await query(
      `SELECT DISTINCT w.steamId FROM WhitelistEntry w
       LEFT JOIN AdminGroup g ON g.id = w.groupId
       LEFT JOIN Clan c ON c.id = w.clanId
       WHERE (w.expiresAt IS NULL OR w.expiresAt > NOW())
         AND (w.clan IN ('RB', 'Royal Battalion') OR c.name = 'Royal Battalion' OR c.tag = 'RB' OR g.name = 'Member')`,
      [],
      'website'
    );
    rbSteamIds = new Set(rows.map((r) => r.steamId));
  } catch (err) {
    log.error({ err }, 'Failed to fetch RB members for status display');
  }
}

async function findExistingMessages(channel, client, serverCount) {
  const messages = await channel.messages.fetch({ limit: 20 });
  const botMessages = messages
    .filter((msg) => msg.author.id === client.user.id && msg.embeds.length > 0)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  return [...botMessages.values()].slice(0, serverCount);
}

async function ensureMessages(channel, client, serverStates, threshold) {
  const existing = await findExistingMessages(channel, client, serverStates.length);

  for (let i = 0; i < serverStates.length; i++) {
    const { name, state } = serverStates[i];

    if (existing[i]) {
      statusMessages.push({ name, messageId: existing[i].id });
      log.info({ name, messageId: existing[i].id }, 'Found existing status message');
    } else {
      const serverStats = state.connected ? await getServerStats(name) : {};
      const embed = buildServerStatusEmbed(state, threshold, rbSteamIds, serverStats);
      const msg = await channel.send({ embeds: [embed] });
      statusMessages.push({ name, messageId: msg.id });
      log.info({ name, messageId: msg.id }, 'Created new status message');
    }
  }
}

async function updateMessages(channel, client) {
  try {
    await refreshRBMembers();
    const serverStates = getAllServerStates();

    if (!serverStates.length) {
      const now = Date.now();
      if (now - lastEmptyStatesWarn >= THROTTLE_MS) {
        lastEmptyStatesWarn = now;
        log.warn('No server states available from SquadJS - status embeds not updating');
      }
      return;
    }

    // Self-recovery: if we have server data but no tracked messages, re-initialize
    if (!statusMessages.length && serverStates.length) {
      log.warn('No status messages tracked but server states exist - attempting re-initialization');
      const seedCfg = await getSeedingConfig();
      const threshold = seedCfg?.seed_threshold ?? config.seeding?.defaultThreshold ?? 40;
      await ensureMessages(channel, client, serverStates, threshold);
      if (statusMessages.length) {
        log.info({ count: statusMessages.length }, 'Self-recovery: re-created status messages');
      }
      return;
    }

    const seedCfg = await getSeedingConfig();
    const threshold = seedCfg?.seed_threshold ?? config.seeding?.defaultThreshold ?? 40;

    for (let i = 0; i < statusMessages.length; i++) {
      const entry = statusMessages[i];
      const serverData = serverStates.find((s) => s.name === entry.name);

      if (!serverData) {
        const now = Date.now();
        if (now - lastNameMismatchWarn >= THROTTLE_MS) {
          lastNameMismatchWarn = now;
          log.warn(
            { expected: entry.name, available: serverStates.map((s) => s.name) },
            'Server name mismatch - no matching state found'
          );
        }
        continue;
      }

      try {
        const serverStats = serverData.state.connected ? await getServerStats(entry.name) : {};
        const embed = buildServerStatusEmbed(serverData.state, threshold, rbSteamIds, serverStats);

        let msg = await channel.messages.fetch(entry.messageId).catch(() => null);
        if (msg) {
          await msg.edit({ embeds: [embed] });
        } else {
          msg = await channel.send({ embeds: [embed] });
          entry.messageId = msg.id;
          log.info({ name: entry.name, messageId: msg.id }, 'Recreated status message');
        }
      } catch (msgErr) {
        log.error({ err: msgErr, name: entry.name }, 'Failed to update individual status message');
      }
    }

    lastSuccessfulUpdate = Date.now();
  } catch (err) {
    log.error({ err }, 'Failed to update server status messages');
    reportError(err, { source: 'scheduler:serverStatus:update' }).catch(() => {});
  }

  // Staleness warning
  const staleDuration = Date.now() - lastSuccessfulUpdate;
  if (staleDuration > THROTTLE_MS) {
    const now = Date.now();
    if (now - lastStaleWarn >= THROTTLE_MS) {
      lastStaleWarn = now;
      log.warn(
        { staleMinutes: Math.round(staleDuration / 60_000) },
        'Server status embeds have not been successfully updated'
      );
    }
  }
}

export async function startStatusUpdater(client) {
  const channelId = config.serverStatus?.channelId;
  if (!channelId) {
    log.warn('No serverStatus.channelId configured - skipping status updater');
    return;
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    log.warn({ channelId }, 'Server status channel not found');
    return;
  }

  _channel = channel;
  _client = client;

  const serverStates = getAllServerStates();
  if (!serverStates.length) {
    log.warn('No SquadJS servers connected - status updater will start with empty state');
  }

  const seedCfg = await getSeedingConfig();
  const threshold = seedCfg?.seed_threshold ?? config.seeding?.defaultThreshold ?? 40;

  // If no server states yet, create placeholder entries from config
  const servers = serverStates.length
    ? serverStates
    : (config.squadjs || []).map((s) => ({ name: s.name, state: { playerCount: 0, connected: false, players: [], publicSlots: 0, reserveSlots: 0, publicQueue: 0, reserveQueue: 0, gameVersion: null, currentLayer: null, currentLayerObj: null, serverName: null, currentMap: null } }));

  if (servers.length) {
    await ensureMessages(channel, client, servers, threshold);
  }

  const intervalMs = config.serverStatus?.updateIntervalMs ?? 60000;
  updateInterval = setInterval(() => updateMessages(channel, client), intervalMs);
  log.info({ channelId, intervalMs, serverCount: servers.length }, 'Server status updater started');
}

export function stopStatusUpdater() {
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
    statusMessages.length = 0;
    _channel = null;
    _client = null;
    log.info('Server status updater stopped');
  }
}
