import { getServerStateById, extractGameMode, setAnnouncerServerId } from './seedingSocket.js';
import {
  getSeedingConfig, getActiveSession, startSession, completeSession,
  updateSessionPeak, updateSessionCallMessage,
  expireOldSessions, getSeedingStats, trackMessage,
  clearTrackedMessages, setLastDailyCallDate, setPanelMessageId,
  setLastResetDate, writeLiveStatus,
} from './seedingService.js';
import { decideSeedingAction } from './seedingLogic.js';
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

export function getTodayDate(timezone) {
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

/** Nightly channel reset + panel re-post time (HH:mm in config timezone). */
export const CHANNEL_RESET_TIME = '04:00';

/**
 * True once the clock has reached the fixed nightly reset time (default 04:00).
 * Combined with last_reset_date so the wipe runs once per calendar day.
 */
export function isAtOrPastResetTime(currentTime, resetTime = CHANNEL_RESET_TIME) {
  return currentTime >= resetTime;
}

/**
 * Accurate seeder-role member count. Role#members only reflects the guild member
 * cache, which is usually incomplete — fetch all members first so the button
 * shows every user with the role, not just cached ones.
 */
export async function countSeederRoleMembers(guild, roleId) {
  if (!guild || !roleId) return null;
  try {
    // Role#members only includes cached guild members. Fetch everyone when the
    // cache is incomplete so the Join Seeders button reflects the true count.
    if (guild.members.cache.size < (guild.memberCount || 0)) {
      await guild.members.fetch();
    }
    const role = guild.roles.cache.get(String(roleId))
      || await guild.roles.fetch(String(roleId)).catch(() => null);
    if (!role) return null;
    return role.members.size;
  } catch (err) {
    log.warn({ err, roleId }, 'Failed to count seeder role members');
    return null;
  }
}

function primarySeederRoleId(cfg) {
  if (cfg?.role_id) return String(cfg.role_id);
  if (Array.isArray(cfg?.role_ids) && cfg.role_ids[0]) return String(cfg.role_ids[0]);
  return null;
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

async function buildPanelPayload(channel, cfg) {
  const tz = cfg.timezone || 'UTC';
  const dailyTime = normalizeTime(cfg.daily_time || '16:00');
  const dailyTs = getDailyTimestamp(dailyTime, tz);
  const roleId = primarySeederRoleId(cfg);
  const seederCount = roleId && channel.guild
    ? await countSeederRoleMembers(channel.guild, roleId)
    : null;
  return buildSeedingPanelMessage(seederCount, dailyTs, cfg.seed_threshold);
}

async function postSeedingPanel(channel, cfg) {
  const panelPayload = await buildPanelPayload(channel, cfg);
  const msg = await channel.send(panelPayload);
  await setPanelMessageId(msg.id);
  const tz = cfg.timezone || 'UTC';
  const today = getTodayDate(tz);
  lastPanelConfig = `${today}|${cfg.daily_time}|${tz}|${cfg.seed_threshold}|${cfg.role_id}`;
  return msg;
}

async function ensureSeedingPanel(client) {
  try {
    const cfg = await getSeedingConfig();
    if (!cfg?.enabled || !cfg.channel_id) return;

    const channel = await client.channels.fetch(cfg.channel_id).catch(() => null);
    if (!channel) return;

    const existingPanel = await findPanelMessage(client, channel, cfg);
    if (existingPanel) {
      log.info('Seeding panel already exists, will refresh on next tick');
      return;
    }

    await postSeedingPanel(channel, cfg);
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

    const panelPayload = await buildPanelPayload(channel, cfg);

    const panelMsg = await findPanelMessage(client, channel, cfg);
    if (panelMsg) {
      await panelMsg.edit(panelPayload);
      log.info('Seeding panel refreshed (config changed)');
    } else {
      await postSeedingPanel(channel, cfg);
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

    let lastResetDateStored = cfg.last_reset_date
      ? new Date(cfg.last_reset_date).toISOString().slice(0, 10)
      : null;

    // Channel reset: every day at 04:00 (config timezone). Wipe other messages so the
    // static panel is left on top; refresh its seeder count (once per calendar day).
    if (isAtOrPastResetTime(currentTime) && lastResetDateStored !== today) {
      await resetChannel(client, cfg);
      await setLastResetDate(today);
      lastResetDateStored = today;
    }

    // Daily call: post if at or past daily time and not yet posted today
    const lastCallDate = cfg.last_daily_call_date
      ? new Date(cfg.last_daily_call_date).toISOString().slice(0, 10)
      : null;
    if (lastCallDate === today) return;
    if (currentTime < dailyTime) return;

    // Self-heal: if reset was missed today (bot was offline past 04:00),
    // clean the channel now before posting the daily call.
    if (lastResetDateStored !== today) {
      await resetChannel(client, cfg);
      await setLastResetDate(today);
      lastResetDateStored = today;
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

    // Keep the static panel; deleting everything else leaves it on top of the channel.
    const messages = await channel.messages.fetch({ limit: 100 });
    const toDelete = messages.filter(msg => !isPanelMessage(client, msg));

    // bulkDelete only handles messages younger than 14 days (filter:true drops old ones silently).
    if (toDelete.size > 0) {
      await channel.bulkDelete(toDelete, true).catch(() => {});
    }

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

    // Refresh seeder count / daily time on the existing panel (do not re-post).
    const panelMsg = await findPanelMessage(client, channel, cfg);
    if (panelMsg) {
      const panelPayload = await buildPanelPayload(channel, cfg);
      await panelMsg.edit(panelPayload);
      const tz = cfg.timezone || 'UTC';
      const today = getTodayDate(tz);
      lastPanelConfig = `${today}|${cfg.daily_time}|${tz}|${cfg.seed_threshold}|${cfg.role_id}`;
    } else {
      // Panel was missing — only then post a new one so the channel has one.
      await postSeedingPanel(channel, cfg);
      log.warn('Seeding panel missing during reset - posted new panel');
    }

    log.info({ deleted: toDelete.size }, 'Seeding channel reset (kept panel on top)');
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
    if (!cfg) return;

    setAnnouncerServerId(cfg.announcer_server_id);
    const state = getServerStateById(cfg.announcer_server_id);
    const session = await getActiveSession();

    // Surface live status for the website on every tick — regardless of whether the
    // announcer is enabled or the socket resolves. The website's live card must reflect
    // real server state even while seeding is disabled, so this write precedes the
    // enabled guard below.
    await writeLiveStatus({
      serverResolvedOk: !!state,
      socketConnected: !!state?.connected,
      currentPopulation: state?.connected ? state.playerCount : null,
      currentLayer: state?.connected ? state.currentLayer : null,
      activeSessionId: session?.id ?? null,
    });

    // Announcer side effects (complete / update active call) only run when enabled.
    if (!cfg.enabled) return;

    // Unavailable (unresolved id or socket down): never act on stale/absent data.
    if (!state || !state.connected) return;

    // Keep the persisted peak current before deciding (peak only grows; stats only).
    if (session) await updateSessionPeak(session.id, state.playerCount);

    // Monitor never creates sessions — only completes or updates an active one.
    // That makes complete → re-seed → complete spam impossible.
    const { action } = decideSeedingAction({
      hasActiveSession: !!session,
      playerCount: state.playerCount,
      seedThreshold: cfg.seed_threshold,
    });

    switch (action) {
      case 'complete': {
        const duration = Math.round(
          (Date.now() - new Date(session.started_at).getTime()) / 60000
        );
        await completeSession(session.id, state.playerCount);
        await postCompletionMessage(client, cfg, session, state, duration);
        break;
      }
      case 'update':
        await updateCallMessage(client, cfg, session, state);
        break;
      default:
        break;
    }
  } catch (err) {
    log.error({ err }, 'Seeding state update failed');
    reportError(err, { source: 'scheduler:seeding:stateUpdate' }).catch(() => {});
  } finally {
    stateUpdateInProgress = false;
  }
}

// ── Helpers ──

function buildSeedingPing(roleIds, headline) {
  const ids = Array.isArray(roleIds) ? roleIds : [];
  const roleMention = ids.map((id) => `<@&${id}>`).join(' ');
  const content = [roleMention, headline].filter(Boolean).join(' ');
  const allowedMentions = ids.length ? { roles: ids } : { parse: [] };
  return { content, allowedMentions };
}

// ── Message posting ──

/**
 * Post a new SEEDING HAS BEGUN message and start a session.
 * Only called from the daily clock or staff send-now (never the monitor).
 * When stampDailyCallDate is true (send-now), also set last_daily_call_date so the
 * clock cannot post a second automatic BEGUN the same day.
 */
export async function postSeedingCall(client, cfg, { stampDailyCallDate = false } = {}) {
  const channel = await client.channels.fetch(cfg.channel_id).catch(() => null);
  if (!channel) {
    log.error({ channelId: cfg.channel_id }, 'Seeding channel not found');
    return null;
  }

  const state = getServerStateById(cfg.announcer_server_id);
  const available = !!state && !!state.connected;
  const playerCount = available ? state.playerCount : null;
  const currentLayer = available ? state.currentLayer : null;
  const currentLayerObj = available ? state.currentLayerObj : null;
  const currentMap = available ? state.currentMap : null;

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

  const { content, allowedMentions } = buildSeedingPing(cfg.role_ids, '**SEEDING HAS BEGUN**');

  const msg = await channel.send({ content, embeds: [embed], allowedMentions });

  // Start a seeding session
  const session = await startSession(currentMap, currentLayer, playerCount ?? 0);
  await updateSessionCallMessage(session.id, msg.id);
  await trackMessage(msg.id, cfg.channel_id, 'call', session.id);

  if (stampDailyCallDate) {
    const tz = cfg.timezone || 'UTC';
    await setLastDailyCallDate(getTodayDate(tz));
  }

  log.info({ messageId: msg.id, sessionId: session.id }, 'Seeding call posted');
  return { messageId: msg.id, sessionId: session.id };
}

/**
 * Staff send-now / recovery: refresh the active call embed, or re-post it if the
 * Discord message was deleted. Never starts a second concurrent session.
 */
export async function refreshActiveCall(client, cfg, session) {
  const state = getServerStateById(cfg.announcer_server_id);
  if (!state || !state.connected) {
    // Still try to re-post a static call if the message is gone; population shows unavailable.
    if (session.call_message_id) {
      const channel = await client.channels.fetch(cfg.channel_id).catch(() => null);
      if (channel) {
        const existing = await channel.messages.fetch(session.call_message_id).catch(() => null);
        if (existing) {
          log.info({ sessionId: session.id }, 'Active call refresh skipped (socket unavailable)');
          return { action: 'skipped_unavailable' };
        }
      }
    }
    await repostCallForSession(client, cfg, session);
    return { action: 'reposted' };
  }

  if (session.call_message_id) {
    const channel = await client.channels.fetch(cfg.channel_id).catch(() => null);
    if (channel) {
      const existing = await channel.messages.fetch(session.call_message_id).catch(() => null);
      if (existing) {
        await updateCallMessage(client, cfg, session, state);
        return { action: 'updated' };
      }
    }
  }

  await repostCallForSession(client, cfg, session, state);
  return { action: 'reposted' };
}

async function repostCallForSession(client, cfg, session, state = null) {
  const channel = await client.channels.fetch(cfg.channel_id).catch(() => null);
  if (!channel) {
    log.error({ channelId: cfg.channel_id }, 'Seeding channel not found for call re-post');
    return;
  }

  const available = !!state && !!state.connected;
  const playerCount = available ? state.playerCount : null;
  const currentLayer = available ? state.currentLayer : (session.layer_name || null);
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

  const { content, allowedMentions } = buildSeedingPing(cfg.role_ids, '**SEEDING HAS BEGUN**');
  const msg = await channel.send({ content, embeds: [embed], allowedMentions });
  await updateSessionCallMessage(session.id, msg.id);
  await trackMessage(msg.id, cfg.channel_id, 'call', session.id);
  log.info({ messageId: msg.id, sessionId: session.id }, 'Seeding call re-posted for active session');
}

async function postCompletionMessage(client, cfg, session, state, duration) {
  const channel = await client.channels.fetch(cfg.channel_id).catch(() => null);
  if (!channel) return;

  const embed = buildSeedingCompletionEmbed({
    mapName: state.currentMap || session.map_name,
    playerCount: state.playerCount,
    duration,
  });

  const { content, allowedMentions } = buildSeedingPing(cfg.role_ids, '**SEEDING COMPLETE**');

  const msg = await channel.send({ content, embeds: [embed], allowedMentions });
  await trackMessage(msg.id, cfg.channel_id, 'completion', session.id);

  log.info({ sessionId: session.id, duration, players: state.playerCount }, 'Seeding completion posted');
}

// Signature of the meaningful, state-derived parts of the call embed: description
// (holds the "N / threshold" population line) plus each field's name+value. Ignores
// inline flags and received-embed extras (type, image proxy_url) so equal state
// compares equal.
function callEmbedSignature(embedData) {
  if (!embedData) return null;
  const fields = (embedData.fields || []).map((f) => `${f.name}=${f.value}`).join('\x1f');
  return `${embedData.description || ''}\x1e${fields}`;
}

export async function updateCallMessage(client, cfg, session, state) {
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

    // Skip the edit when nothing visible changed — the message updated every 60s tick
    // (and showed a perpetual "(edited)") only because of a ticking timestamp field.
    if (callEmbedSignature(message.embeds[0]?.data) === callEmbedSignature(embed.toJSON())) return;

    await message.edit({ embeds: [embed] });
  } catch (err) {
    log.warn({ err, messageId: session.call_message_id }, 'Failed to update call message');
  }
}
