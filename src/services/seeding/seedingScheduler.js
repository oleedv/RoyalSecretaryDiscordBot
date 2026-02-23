import { getServerState, onStateChange } from './seedingSocket.js';
import {
  getSeedingConfig, getActiveSession, startSession, completeSession,
  resetSession, updateSessionPeak, updateSessionCallMessage,
  expireOldSessions, getAverageSeedTime, trackMessage,
} from './seedingService.js';
import {
  buildSeedingCallEmbed, buildSeedingCompletionEmbed,
  buildSeederRoleComponents, getMapThumbnailUrl,
} from './seedingEmbeds.js';
import config from '../../config.js';
import logger from '../../logger.js';

const log = logger.child({ module: 'seedingScheduler' });

let dailyCheckInterval = null;
let monitorInterval = null;
let unsubscribeSocket = null;
let lastDailyCallDate = null;
let checking = false;

export async function startScheduler(client) {
  log.info('Starting seeding scheduler');

  await expireOldSessions();

  const checkMs = config.seeding?.schedulerCheckMs || 60000;
  const monitorMs = config.seeding?.monitorIntervalMs || 120000;

  dailyCheckInterval = setInterval(() => checkDailyCall(client), checkMs);
  monitorInterval = setInterval(() => checkPopulation(client), monitorMs);
  unsubscribeSocket = onStateChange(() => checkPopulation(client));

  // Run initial checks
  checkDailyCall(client);
  checkPopulation(client);
}

export function stopScheduler() {
  if (dailyCheckInterval) { clearInterval(dailyCheckInterval); dailyCheckInterval = null; }
  if (monitorInterval) { clearInterval(monitorInterval); monitorInterval = null; }
  if (unsubscribeSocket) { unsubscribeSocket(); unsubscribeSocket = null; }
  log.info('Seeding scheduler stopped');
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
    const currentTime = getCurrentTime(tz);
    const today = getTodayDate(tz);

    // Support both "HH:MM" (daily_time) and legacy integer hour (daily_hour)
    const configuredTime = cfg.daily_time || `${String(cfg.daily_hour ?? 16).padStart(2, '0')}:00`;

    if (currentTime !== configuredTime || lastDailyCallDate === today) return;

    lastDailyCallDate = today;
    log.info({ time: currentTime, date: today }, 'Posting daily seeding call');

    await postSeedingCall(client, cfg);
  } catch (err) {
    log.error({ err }, 'Daily call check failed');
  }
}

async function checkPopulation(client) {
  if (checking) return;
  checking = true;

  try {
    const cfg = await getSeedingConfig();
    if (!cfg?.enabled) return;

    const state = getServerState();
    if (!state.connected) return;

    const session = await getActiveSession();

    if (session) {
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
        return;
      }
    }
  } catch (err) {
    log.error({ err }, 'Population check failed');
  } finally {
    checking = false;
  }
}

async function postSeedingCall(client, cfg) {
  const channel = await client.channels.fetch(cfg.channel_id).catch(() => null);
  if (!channel) {
    log.error({ channelId: cfg.channel_id }, 'Seeding channel not found');
    return;
  }

  const state = getServerState();
  const stats = await getAverageSeedTime();
  const thumbnailUrl = getMapThumbnailUrl(state.currentLayer);

  const embed = buildSeedingCallEmbed({
    mapName: state.currentMap,
    layerName: state.currentLayer,
    playerCount: state.playerCount,
    threshold: cfg.seed_threshold,
    thumbnailUrl,
    avgSeedTime: stats.avgMinutes,
    serverName: cfg.server_name || 'Royal Battalion',
  });

  const components = buildSeederRoleComponents();
  const content = cfg.role_id ? `<@&${cfg.role_id}>` : undefined;

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

  const msg = await channel.send({ embeds: [embed] });
  await trackMessage(msg.id, cfg.channel_id, 'completion', session.id);

  log.info({ sessionId: session.id, duration, players: state.playerCount }, 'Seeding completion posted');
}
