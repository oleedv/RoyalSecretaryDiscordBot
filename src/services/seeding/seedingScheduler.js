import { getServerStateById, extractGameMode, setAnnouncerServerId } from './seedingSocket.js';
import {
  getSeedingConfig, getActiveSession, startSession, completeSession,
  resetSession, updateSessionPeak, updateSessionCallMessage,
  expireOldSessions, getSeedingStats, trackMessage,
  clearTrackedMessages, setLastDailyCallDate, setPanelMessageId,
  setLastResetDate, writeLiveStatus,
} from './seedingService.js';
import {
  buildSeedingCallEmbed, buildSeedingCompletionEmbed,
  buildSeedingPanelMessage, getLayerImageUrl,
} from './seedingEmbeds.js';
import { createScheduler } from '../../utils/scheduler.js';
import config from '../../config.js';
import logger from '../../logger.js';
import { reportError } from '../admin/errorAlertService.js';

const log = logger.child({ module: 'seedingScheduler' });

let lastPanelConfig = null;

const checkMs = config.seeding?.schedulerCheckMs || 60000;

const dailyCheckScheduler = createScheduler({
  name: 'seedingDailyCheck',
  intervalMs: checkMs,
  tick: checkDailyCall,
});

const monitorScheduler = createScheduler({
  name: 'seedingMonitor',
  intervalMs: checkMs,
  tick: updateSeedingState,
});

export function isSchedulerActive() {
  return dailyCheckScheduler.isActive();
}

export async function startScheduler(client) {
  log.info('Starting seeding scheduler');
  await expireOldSessions();
  await ensureSeedingPanel(client);
  dailyCheckScheduler.start(client);
  monitorScheduler.start(client);
}

export function stopScheduler() {
  dailyCheckScheduler.stop();
  monitorScheduler.stop();
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
 * Uses Intl to get the UTC offset for the target timezone, then applies it.
 */
function getDailyTimestamp(dailyTime, timezone) {
  const [h, m] = dailyTime.split(':').map(Number);
  const dateStr = getTodayDate(timezone);
  const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  try {
    // Get the UTC offset by formatting a reference date with timeZoneName
    const ref = new Date(`${dateStr}T12:00:00.000Z`);
    const parts = new Intl.DateTimeFormat('en', { timeZone: timezone, timeZoneName: 'longOffset' }).formatToParts(ref);
    const tzPart = parts.find(p => p.type === 'timeZoneName')?.value || '';
    // Parse offset like "GMT+02:00" or "GMT-05:00" or "GMT"
    const offsetMatch = tzPart.match(/GMT([+-])(\d{1,2}):?(\d{2})?/);
    let offsetMinutes = 0;
    if (offsetMatch) {
      const sign = offsetMatch[1] === '+' ? 1 : -1;
      offsetMinutes = sign * (parseInt(offsetMatch[2], 10) * 60 + parseInt(offsetMatch[3] || '0', 10));
    }
    // Build the UTC time: local time minus offset = UTC
    const utc = new Date(`${dateStr}T${timeStr}:00.000Z`);
    utc.setUTCMinutes(utc.getUTCMinutes() - offsetMinutes);
    return Math.floor(utc.getTime() / 1000);
  } catch {
    // Fallback: treat as UTC
    return Math.floor(new Date(`${dateStr}T${timeStr}:00.000Z`).getTime() / 1000);
  }
}

// ── Panel (persistent embed with buttons) ──

async function findPanelMessage(client, channel, cfg) {
  // Try stored ID first
  if (cfg.panel_message_id) {
    try {
      const msg = await channel.messages.fetch(cfg.panel_message_id);
      if (msg) return msg;
    } catch { /* message may have been deleted */ }
  }

  // Fallback: scan last 50 messages
  const messages = await channel.messages.fetch({ limit: 50 });
  const panelMsg = messages.find(
    msg => msg.author.id === client.user.id &&
      msg.components.some(row => row.components.some(c => c.customId === 'seeding_join'))
  );

  // Update stored ID if found by scan
  if (panelMsg && panelMsg.id !== cfg.panel_message_id) {
    await setPanelMessageId(panelMsg.id);
  }

  return panelMsg || null;
}

async function ensureSeedingPanel(client) {
  try {
    const cfg = await getSeedingConfig();
    if (!cfg?.enabled || !cfg.channel_id) return;

    const channel = await client.channels.fetch(cfg.channel_id).catch(() => null);
    if (!channel) return;

    const tz = cfg.timezone || 'UTC';
    const today = getTodayDate(tz);
    const configKey = `${today}|${cfg.daily_time}|${tz}|${cfg.seed_threshold}|${cfg.role_id}`;

    const existingPanel = await findPanelMessage(client, channel, cfg);
    if (existingPanel) {
      log.info('Seeding panel already exists, will refresh on next tick');
      return;
    }

    // Post the panel
    const dailyTime = normalizeTime(cfg.daily_time || '16:00');
    const dailyTs = getDailyTimestamp(dailyTime, tz);

    let seederCount = null;
    if (cfg.role_id && channel.guild) {
      try {
        seederCount = channel.guild.roles.cache.get(cfg.role_id)?.members?.size ?? null;
      } catch { /* role may not exist */ }
    }

    const panelPayload = buildSeedingPanelMessage(seederCount, dailyTs, cfg.seed_threshold);
    const msg = await channel.send(panelPayload);
    await setPanelMessageId(msg.id);
    lastPanelConfig = configKey;
    log.info('Seeding panel posted');
  } catch (err) {
    log.error({ err }, 'Failed to ensure seeding panel');
    reportError(err, { source: 'scheduler:seeding:ensurePanel' }).catch(() => {});
  }
}

async function refreshSeedingPanel(client, cfg) {
  const tz = cfg.timezone || 'UTC';
  const today = getTodayDate(tz);
  const configKey = `${today}|${cfg.daily_time}|${tz}|${cfg.seed_threshold}|${cfg.role_id}`;
  if (lastPanelConfig === configKey) return;

  try {
    const channel = await client.channels.fetch(cfg.channel_id).catch(() => null);
    if (!channel) return;

    const dailyTime = normalizeTime(cfg.daily_time || '16:00');
    const dailyTs = getDailyTimestamp(dailyTime, tz);

    let seederCount = null;
    if (cfg.role_id && channel.guild) {
      try {
        seederCount = channel.guild.roles.cache.get(cfg.role_id)?.members?.size ?? null;
      } catch { /* role may not exist */ }
    }

    const panelPayload = buildSeedingPanelMessage(seederCount, dailyTs, cfg.seed_threshold);

    const panelMsg = await findPanelMessage(client, channel, cfg);
    if (panelMsg) {
      await panelMsg.edit(panelPayload);
      log.info('Seeding panel refreshed (config changed)');
    } else {
      const msg = await channel.send(panelPayload);
      await setPanelMessageId(msg.id);
      log.warn('Seeding panel not found - re-posted');
    }

    lastPanelConfig = configKey;
  } catch (err) {
    log.warn({ err }, 'Failed to refresh seeding panel');
  }
}

// ── Daily call + channel reset ──

async function checkDailyCall(client) {
  try {
    const cfg = await getSeedingConfig();
    if (!cfg?.enabled || !cfg.channel_id) return;

    await refreshSeedingPanel(client, cfg);

    const tz = cfg.timezone || 'UTC';
    const today = getTodayDate(tz);
    const currentTime = getCurrentTime(tz);
    const dailyTime = normalizeTime(cfg.daily_time || '16:00');

    const lastResetDateStored = cfg.last_reset_date
      ? new Date(cfg.last_reset_date).toISOString().slice(0, 10)
      : null;

    // Channel reset: 1 hour before daily call, clean up everything except panel (once per day)
    if (isInResetWindow(currentTime, dailyTime) && lastResetDateStored !== today) {
      await resetChannel(client, cfg);
      await setLastResetDate(today);
    }

    // Daily call: post if at or past daily time and not yet posted today
    const lastCallDate = cfg.last_daily_call_date
      ? new Date(cfg.last_daily_call_date).toISOString().slice(0, 10)
      : null;
    if (lastCallDate === today) return;
    if (currentTime < dailyTime) return;

    // Self-heal: if reset was missed today (bot was offline during reset window),
    // clean the channel now before posting the daily call.
    if (lastResetDateStored !== today) {
      await resetChannel(client, cfg);
      await setLastResetDate(today);
    }

    await setLastDailyCallDate(today);
    log.info({ time: currentTime, date: today }, 'Posting daily seeding call');

    await postSeedingCall(client, cfg);
  } catch (err) {
    log.error({ err }, 'Daily call check failed');
    reportError(err, { source: 'scheduler:seeding:dailyCall' }).catch(() => {});
  }
}

function isPanelMessage(client, msg) {
  return (
    msg.author.id === client.user.id &&
    msg.components.some(row => row.components.some(c => c.customId === 'seeding_join'))
  );
}

async function resetChannel(client, cfg) {
  try {
    const channel = await client.channels.fetch(cfg.channel_id).catch(() => null);
    if (!channel) return;

    const messages = await channel.messages.fetch({ limit: 100 });
    const toDelete = messages.filter(msg => !isPanelMessage(client, msg));

    if (toDelete.size === 0) return;

    // bulkDelete only handles messages younger than 14 days (filter:true drops old ones silently).
    await channel.bulkDelete(toDelete, true).catch(() => {});

    // Fallback: iterate any messages still in the channel (those >14 days old) and delete one-by-one.
    const remaining = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (remaining) {
      let oldDeleted = 0;
      for (const msg of remaining.values()) {
        if (isPanelMessage(client, msg)) continue;
        await msg.delete().catch(() => {});
        oldDeleted += 1;
        await new Promise(r => setTimeout(r, 250));
      }
      if (oldDeleted > 0) {
        log.info({ oldDeleted }, 'Deleted messages older than bulkDelete limit');
      }
    }

    await clearTrackedMessages(cfg.channel_id);

    // Expire any lingering active session
    await expireOldSessions();

    log.info({ deleted: toDelete.size }, 'Seeding channel reset (kept panel only)');
  } catch (err) {
    log.warn({ err }, 'Failed to reset seeding channel');
  }
}

// ── Seeding state monitor ──

let stateUpdateInProgress = false;

async function updateSeedingState(client) {
  if (stateUpdateInProgress) return;
  stateUpdateInProgress = true;
  try {
    const cfg = await getSeedingConfig();
    if (!cfg?.enabled) return;

    setAnnouncerServerId(cfg.announcer_server_id);
    const state = getServerStateById(cfg.announcer_server_id);
    const session = await getActiveSession();

    // Surface live status for the website regardless of resolution outcome.
    await writeLiveStatus({
      serverResolvedOk: !!state,
      socketConnected: !!state?.connected,
      currentPopulation: state?.connected ? state.playerCount : null,
      currentLayer: state?.connected ? state.currentLayer : null,
      activeSessionId: session?.id ?? null,
    });

    // Unavailable (unresolved id or socket down): never act on stale/absent data.
    if (!state || !state.connected) return;

    // No active session - check if we should re-seed (server crash recovery)
    if (!session) {
      const tz = cfg.timezone || 'UTC';
      const dailyTime = normalizeTime(cfg.daily_time || '16:00');
      const currentTime = getCurrentTime(tz);
      const today = getTodayDate(tz);
      const lastCallDate = cfg.last_daily_call_date
        ? new Date(cfg.last_daily_call_date).toISOString().slice(0, 10)
        : null;

      // Re-seed if today's call was already posted, we're past daily time,
      // we're not in the reset window, and server has players (avoid loop when server is down)
      if (lastCallDate === today && currentTime >= dailyTime && !isInResetWindow(currentTime, dailyTime) && state.playerCount > 0) {
        log.info('No active session in seeding window - re-seeding');
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
      // Don't post a new call here - the re-seed logic above handles it on the next tick
      return;
    }

    // Normal update
    await updateCallMessage(client, cfg, session, state);
  } catch (err) {
    log.error({ err }, 'Seeding state update failed');
    reportError(err, { source: 'scheduler:seeding:stateUpdate' }).catch(() => {});
  } finally {
    stateUpdateInProgress = false;
  }
}

// ── Message posting ──

export async function postSeedingCall(client, cfg) {
  const channel = await client.channels.fetch(cfg.channel_id).catch(() => null);
  if (!channel) {
    log.error({ channelId: cfg.channel_id }, 'Seeding channel not found');
    return;
  }

  const state = getServerStateById(cfg.announcer_server_id);
  const available = !!state && !!state.connected;
  const playerCount = available ? state.playerCount : null;
  const currentLayer = available ? state.currentLayer : null;
  const currentLayerObj = available ? state.currentLayerObj : null;

  const stats = await getSeedingStats();
  const gameMode = extractGameMode(currentLayer);
  const thumbnailUrl = getLayerImageUrl(currentLayerObj, currentLayer);

  const embed = buildSeedingCallEmbed({
    layerName: currentLayer,
    playerCount,
    threshold: cfg.seed_threshold,
    thumbnailUrl,
    avgSeedTime: stats.avgMinutes,
    avgSeedTrend: stats.trend,
    gameMode,
    fastestSeed: stats.fastest,
  });

  const roleIds = Array.isArray(cfg.role_ids) ? cfg.role_ids : [];
  const roleMention = roleIds.map((id) => `<@&${id}>`).join(' ');
  const content = [roleMention, '**SEEDING HAS BEGUN**'].filter(Boolean).join(' ');
  const allowedMentions = roleIds.length ? { roles: roleIds } : { parse: [] };

  const msg = await channel.send({ content, embeds: [embed], allowedMentions });

  // Start a seeding session
  const session = await startSession(state?.currentMap ?? null, currentLayer, playerCount ?? 0);
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

  const roleIds = Array.isArray(cfg.role_ids) ? cfg.role_ids : [];
  const roleMention = roleIds.map((id) => `<@&${id}>`).join(' ');
  const content = [roleMention, '**SEEDING COMPLETE**'].filter(Boolean).join(' ');
  const allowedMentions = roleIds.length ? { roles: roleIds } : { parse: [] };

  const msg = await channel.send({ content, embeds: [embed], allowedMentions });
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
      gameMode,
      fastestSeed: stats.fastest,
    });

    await message.edit({ embeds: [embed] });
  } catch (err) {
    log.warn({ err, messageId: session.call_message_id }, 'Failed to update call message');
  }
}
