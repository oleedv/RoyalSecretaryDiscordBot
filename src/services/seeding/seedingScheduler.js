import { getServerState, extractGameMode } from './seedingSocket.js';
import {
  getSeedingConfig, getActiveSession, startSession, completeSession,
  resetSession, updateSessionPeak, updateSessionCallMessage,
  expireOldSessions, getSeedingStats, trackMessage,
  clearTrackedMessages, setLastDailyCallDate,
} from './seedingService.js';
import {
  buildSeedingCallEmbed, buildSeedingCompletionEmbed,
  buildSeederRoleComponents, getLayerImageUrl,
} from './seedingEmbeds.js';
import config from '../../config.js';
import logger from '../../logger.js';

const log = logger.child({ module: 'seedingScheduler' });

let dailyCheckInterval = null;
let monitorInterval = null;

export function isSchedulerActive() {
  return !!dailyCheckInterval;
}

export async function startScheduler(client) {
  log.info('Starting seeding scheduler');

  await expireOldSessions();
  await ensureSeedingEmbed(client);

  const checkMs = config.seeding?.schedulerCheckMs || 60000;

  dailyCheckInterval = setInterval(() => checkDailyCall(client), checkMs);
  monitorInterval = setInterval(() => updateSeedingState(client), checkMs);

  // Run initial checks
  checkDailyCall(client);
  updateSeedingState(client);
}

export function stopScheduler() {
  if (dailyCheckInterval) { clearInterval(dailyCheckInterval); dailyCheckInterval = null; }
  if (monitorInterval) { clearInterval(monitorInterval); monitorInterval = null; }
  log.info('Seeding scheduler stopped');
}

async function ensureSeedingEmbed(client) {
  try {
    const cfg = await getSeedingConfig();
    if (!cfg?.enabled || !cfg.channel_id) return;

    const session = await getActiveSession();
    if (session?.call_message_id) return;

    const channel = await client.channels.fetch(cfg.channel_id).catch(() => null);
    if (!channel) return;

    // Scan for existing seeding embed with buttons (survives restarts)
    const messages = await channel.messages.fetch({ limit: 50 });
    const existing = messages.find(
      msg => msg.author.id === client.user.id &&
        msg.components.some(row => row.components.some(c => c.customId === 'seeding_join'))
    );

    if (existing && !session) {
      // Embed exists but no session — create one linked to it for live updates
      const newSession = await startSession(null, null, 0);
      await updateSessionCallMessage(newSession.id, existing.id);
      log.info({ messageId: existing.id }, 'Recovered seeding session from existing embed');
      return;
    }

    if (!existing) {
      // No embed at all — post one without role ping
      await postSeedingCall(client, cfg, { ping: false });
    }
  } catch (err) {
    log.error({ err }, 'Failed to ensure seeding embed');
  }
}

function getCurrentTime(timezone) {
  try {
    const now = new Date();
    const hour = parseInt(
      new Intl.DateTimeFormat('en', { hour: 'numeric', hour12: false, timeZone: timezone }).format(now),
      10,
    );
    const minute = parseInt(
      new Intl.DateTimeFormat('en', { minute: 'numeric', timeZone: timezone }).format(now),
      10,
    );
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  } catch {
    const now = new Date();
    return `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  }
}

function getTodayDate(timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

async function checkDailyCall(client) {
  try {
    const cfg = await getSeedingConfig();
    if (!cfg?.enabled || !cfg.channel_id) return;

    const tz = cfg.timezone || 'UTC';
    const today = getTodayDate(tz);

    // Check DB-persisted date to avoid duplicate posts (survives restarts)
    const lastCallDate = cfg.last_daily_call_date
      ? new Date(cfg.last_daily_call_date).toISOString().slice(0, 10)
      : null;
    if (lastCallDate === today) return;

    // Support "HH:MM" or "HHMM" formats
    let configuredTime = cfg.daily_time || '16:00';
    if (/^\d{4}$/.test(configuredTime)) {
      configuredTime = `${configuredTime.slice(0, 2)}:${configuredTime.slice(2)}`;
    }

    const currentTime = getCurrentTime(tz);
    // Post if current time is at or past the configured time (catches restarts)
    if (currentTime < configuredTime) return;

    await setLastDailyCallDate(today);
    log.info({ time: currentTime, date: today }, 'Posting daily seeding call');

    await postSeedingCall(client, cfg);
  } catch (err) {
    log.error({ err }, 'Daily call check failed');
  }
}

async function updateSeedingState(client) {
  try {
    const cfg = await getSeedingConfig();
    if (!cfg?.enabled) return;

    const state = getServerState();
    if (!state.connected) return;

    const session = await getActiveSession();
    if (!session) return;

    await updateSessionPeak(session.id, state.playerCount);

    if (state.playerCount >= cfg.seed_threshold) {
      const duration = Math.round(
        (Date.now() - new Date(session.started_at).getTime()) / 60000
      );
      await completeSession(session.id, state.playerCount);
      await postCompletionMessage(client, cfg, session, state, duration);
      return;
    }

    if (state.playerCount < cfg.reset_threshold && session.peak_players >= cfg.reset_threshold) {
      await resetSession(session.id);
      log.info({ sessionId: session.id }, 'Session reset — posting new seeding call');
      await postSeedingCall(client, cfg, { ping: false });
      return;
    }

    // Always update the call message (like server status does)
    await updateCallMessage(client, cfg, session, state);
  } catch (err) {
    log.error({ err }, 'Seeding state update failed');
  }
}

async function postSeedingCall(client, cfg, { ping = true } = {}) {
  const channel = await client.channels.fetch(cfg.channel_id).catch(() => null);
  if (!channel) {
    log.error({ channelId: cfg.channel_id }, 'Seeding channel not found');
    return;
  }

  // Purge all messages from the seeding channel for a clean slate
  try {
    let deleted;
    do {
      deleted = await channel.bulkDelete(100, true);
    } while (deleted.size > 0);
    await clearTrackedMessages(cfg.channel_id);
  } catch (err) {
    log.warn({ err }, 'Failed to purge seeding channel');
  }

  const state = getServerState();
  const stats = await getSeedingStats();
  const gameMode = extractGameMode(state.currentLayer);
  const thumbnailUrl = getLayerImageUrl(state.currentLayerObj, state.currentLayer);

  const embed = buildSeedingCallEmbed({
    layerName: state.currentLayer,
    playerCount: state.playerCount,
    threshold: cfg.seed_threshold,
    thumbnailUrl,
    avgSeedTime: stats.avgMinutes,
    avgSeedTrend: stats.trend,
    serverName: state.serverName,
    gameMode,
    fastestSeed: stats.fastest,
  });

  // Fetch seeder role member count for button label
  let seederCount = null;
  if (cfg.role_id && channel.guild) {
    try {
      await channel.guild.members.fetch();
      const role = await channel.guild.roles.fetch(cfg.role_id);
      seederCount = role?.members?.size ?? null;
    } catch { /* role may not exist */ }
  }

  const components = buildSeederRoleComponents(seederCount);
  const content = ping
    ? ([cfg.role_id].filter(Boolean).map(id => `<@&${id}>`).join(' ') || undefined)
    : undefined;

  const msg = await channel.send({ content, embeds: [embed], components });

  // Start a seeding session
  const session = await startSession(state.currentMap, state.currentLayer, state.playerCount);
  await updateSessionCallMessage(session.id, msg.id);
  await trackMessage(msg.id, cfg.channel_id, 'call', session.id);

  log.info({ messageId: msg.id, sessionId: session.id }, 'Seeding call posted');
}

async function postCompletionMessage(client, cfg, session, state, duration) {
  const channel = await client.channels.fetch(cfg.channel_id).catch(() => null);
  if (!channel) return;

  const embed = buildSeedingCompletionEmbed({
    mapName: state.currentMap || session.map_name,
    playerCount: state.playerCount,
    duration,
  });

  const content = [cfg.role_id].filter(Boolean).map(id => `<@&${id}>`).join(' ') || undefined;

  const msg = await channel.send({ content, embeds: [embed] });
  await trackMessage(msg.id, cfg.channel_id, 'completion', session.id);

  log.info({ sessionId: session.id, duration, players: state.playerCount }, 'Seeding completion posted');
}

async function updateCallMessage(client, cfg, session, state) {
  if (!session.call_message_id || !cfg.channel_id) return;

  try {
    const channel = await client.channels.fetch(cfg.channel_id).catch(() => null);
    if (!channel) return;

    const message = await channel.messages.fetch(session.call_message_id).catch(() => null);
    if (!message) return;

    // Clean up non-embed messages (user hype messages, etc.)
    const allMessages = await channel.messages.fetch({ limit: 50 });
    const toDelete = allMessages.filter(m => m.id !== session.call_message_id);
    if (toDelete.size > 0) {
      await channel.bulkDelete(toDelete, true).catch(() => {});
    }

    const stats = await getSeedingStats();
    const gameMode = extractGameMode(state.currentLayer);
    const thumbnailUrl = getLayerImageUrl(state.currentLayerObj, state.currentLayer);

    const embed = buildSeedingCallEmbed({
      layerName: state.currentLayer,
      playerCount: state.playerCount,
      threshold: cfg.seed_threshold,
      thumbnailUrl,
      avgSeedTime: stats.avgMinutes,
      avgSeedTrend: stats.trend,
      serverName: state.serverName,
      gameMode,
      fastestSeed: stats.fastest,
    });

    await message.edit({ embeds: [embed] });
  } catch (err) {
    log.warn({ err, messageId: session.call_message_id }, 'Failed to update call message');
  }
}
