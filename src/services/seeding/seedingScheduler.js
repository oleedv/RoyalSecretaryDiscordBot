import { getServerState, extractGameMode } from './seedingSocket.js';
import {
  getSeedingConfig, getActiveSession, startSession, completeSession,
  resetSession, updateSessionPeak, updateSessionCallMessage,
  expireOldSessions, getSeedingStats, trackMessage,
  clearTrackedMessages, setLastDailyCallDate,
} from './seedingService.js';
import {
  buildSeedingCallEmbed, buildSeedingCompletionEmbed,
  buildSeedingPanelMessage, getLayerImageUrl,
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
  await ensureSeedingPanel(client);

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

// ── Time helpers ──

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

function normalizeTime(time) {
  if (/^\d{4}$/.test(time)) return `${time.slice(0, 2)}:${time.slice(2)}`;
  return time;
}

function subtractOneHour(time) {
  const [h, m] = time.split(':').map(Number);
  const newH = (h - 1 + 24) % 24;
  return `${String(newH).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Check if currentTime is in the reset window (1h before daily call).
 * Reset window: [resetTime, dailyTime)
 */
function isInResetWindow(currentTime, dailyTime) {
  const resetTime = subtractOneHour(dailyTime);
  if (resetTime < dailyTime) {
    return currentTime >= resetTime && currentTime < dailyTime;
  }
  // Wraps midnight (e.g. daily=00:30, reset=23:30)
  return currentTime >= resetTime || currentTime < dailyTime;
}

/**
 * Convert daily_time + timezone to today's Unix timestamp for Discord <t:> formatting.
 */
function getDailyTimestamp(dailyTime, timezone) {
  const [h, m] = dailyTime.split(':').map(Number);
  const dateStr = getTodayDate(timezone);
  // Create a UTC date at the target date+time, then adjust for timezone offset
  const utcGuess = new Date(`${dateStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`);
  try {
    const actualHour = parseInt(
      new Intl.DateTimeFormat('en', { hour: 'numeric', hour12: false, timeZone: timezone }).format(utcGuess),
      10,
    );
    const diff = h - actualHour;
    utcGuess.setUTCHours(utcGuess.getUTCHours() + diff);
  } catch { /* fall through with UTC guess */ }
  return Math.floor(utcGuess.getTime() / 1000);
}

// ── Panel (persistent embed with buttons) ──

async function ensureSeedingPanel(client) {
  try {
    const cfg = await getSeedingConfig();
    if (!cfg?.enabled || !cfg.channel_id) return;

    const channel = await client.channels.fetch(cfg.channel_id).catch(() => null);
    if (!channel) return;

    const messages = await channel.messages.fetch({ limit: 50 });
    const hasPanel = messages.some(
      msg => msg.author.id === client.user.id &&
        msg.components.some(row => row.components.some(c => c.customId === 'seeding_join'))
    );

    if (hasPanel) {
      log.info('Seeding panel already exists');
      return;
    }

    // Post the panel
    const dailyTime = normalizeTime(cfg.daily_time || '16:00');
    const tz = cfg.timezone || 'UTC';
    const dailyTs = getDailyTimestamp(dailyTime, tz);

    let seederCount = null;
    if (cfg.role_id && channel.guild) {
      try {
        await channel.guild.members.fetch();
        const role = await channel.guild.roles.fetch(cfg.role_id);
        seederCount = role?.members?.size ?? null;
      } catch { /* role may not exist */ }
    }

    const panelPayload = buildSeedingPanelMessage(seederCount, dailyTs, cfg.seed_threshold);
    await channel.send(panelPayload);
    log.info('Seeding panel posted');
  } catch (err) {
    log.error({ err }, 'Failed to ensure seeding panel');
  }
}

// ── Daily call + channel reset ──

async function checkDailyCall(client) {
  try {
    const cfg = await getSeedingConfig();
    if (!cfg?.enabled || !cfg.channel_id) return;

    const tz = cfg.timezone || 'UTC';
    const today = getTodayDate(tz);
    const currentTime = getCurrentTime(tz);
    const dailyTime = normalizeTime(cfg.daily_time || '16:00');

    // Channel reset: 1 hour before daily call, clean up everything except panel
    if (isInResetWindow(currentTime, dailyTime)) {
      await resetChannel(client, cfg);
    }

    // Daily call: post if at or past daily time and not yet posted today
    const lastCallDate = cfg.last_daily_call_date
      ? new Date(cfg.last_daily_call_date).toISOString().slice(0, 10)
      : null;
    if (lastCallDate === today) return;
    if (currentTime < dailyTime) return;

    await setLastDailyCallDate(today);
    log.info({ time: currentTime, date: today }, 'Posting daily seeding call');

    await postSeedingCall(client, cfg);
  } catch (err) {
    log.error({ err }, 'Daily call check failed');
  }
}

async function resetChannel(client, cfg) {
  try {
    const channel = await client.channels.fetch(cfg.channel_id).catch(() => null);
    if (!channel) return;

    const messages = await channel.messages.fetch({ limit: 50 });
    const toDelete = messages.filter(
      msg => !(
        msg.author.id === client.user.id &&
        msg.components.some(row => row.components.some(c => c.customId === 'seeding_join'))
      )
    );

    if (toDelete.size === 0) return;

    await channel.bulkDelete(toDelete, true).catch(() => {});
    await clearTrackedMessages(cfg.channel_id);

    // Expire any lingering active session
    await expireOldSessions();

    log.info({ deleted: toDelete.size }, 'Seeding channel reset (kept panel only)');
  } catch (err) {
    log.warn({ err }, 'Failed to reset seeding channel');
  }
}

// ── Seeding state monitor ──

async function updateSeedingState(client) {
  try {
    const cfg = await getSeedingConfig();
    if (!cfg?.enabled) return;

    const state = getServerState();
    if (!state.connected) return;

    const session = await getActiveSession();

    // No active session — check if we should re-seed (server crash recovery)
    if (!session) {
      const tz = cfg.timezone || 'UTC';
      const dailyTime = normalizeTime(cfg.daily_time || '16:00');
      const currentTime = getCurrentTime(tz);
      const today = getTodayDate(tz);
      const lastCallDate = cfg.last_daily_call_date
        ? new Date(cfg.last_daily_call_date).toISOString().slice(0, 10)
        : null;

      // Re-seed if today's call was already posted, we're past daily time,
      // and we're not in the reset window
      if (lastCallDate === today && currentTime >= dailyTime && !isInResetWindow(currentTime, dailyTime)) {
        log.info('No active session in seeding window — re-seeding');
        await postSeedingCall(client, cfg);
      }
      return;
    }

    await updateSessionPeak(session.id, state.playerCount);

    // Completion: threshold reached
    if (state.playerCount >= cfg.seed_threshold) {
      const duration = Math.round(
        (Date.now() - new Date(session.started_at).getTime()) / 60000
      );
      await completeSession(session.id, state.playerCount);
      await postCompletionMessage(client, cfg, session, state, duration);
      return;
    }

    // Reset: players dropped below reset threshold after reaching it
    if (state.playerCount < cfg.reset_threshold && session.peak_players >= cfg.reset_threshold) {
      await resetSession(session.id);
      log.info({ sessionId: session.id }, 'Session reset (population dropped)');
      // Don't post a new call here — the re-seed logic above handles it on the next tick
      return;
    }

    // Normal update
    await updateCallMessage(client, cfg, session, state);
  } catch (err) {
    log.error({ err }, 'Seeding state update failed');
  }
}

// ── Message posting ──

async function postSeedingCall(client, cfg) {
  const channel = await client.channels.fetch(cfg.channel_id).catch(() => null);
  if (!channel) {
    log.error({ channelId: cfg.channel_id }, 'Seeding channel not found');
    return;
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

  const content = [cfg.role_id].filter(Boolean).map(id => `<@&${id}>`).join(' ') || undefined;

  const msg = await channel.send({ content, embeds: [embed] });

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
