import { createScheduler } from '../../utils/scheduler.js';
import config from '../../config.js';
import logger from '../../logger.js';
import { reportError } from '../admin/errorAlertService.js';
import { runDailyModerationReport, getCurrentState } from './moderationService.js';

const log = logger.child({ module: 'moderationScheduler' });

const checkMs = config.moderation?.schedulerCheckMs || 60000;

const dailyScheduler = createScheduler({
  name: 'moderationDailyCheck',
  intervalMs: checkMs,
  tick: checkDailyRun,
});

export function isSchedulerActive() {
  return dailyScheduler.isActive();
}

export async function startScheduler(client) {
  const cfg = config.moderation || {};
  if (!cfg.enabled) {
    log.info('Moderation scheduler disabled in config; not starting');
    return;
  }
  if (!cfg.channelId) {
    log.warn('Moderation enabled but channelId missing; not starting');
    return;
  }
  log.info({ dailyTime: cfg.dailyTime, timezone: cfg.timezone, channelId: cfg.channelId }, 'Starting moderation scheduler');
  dailyScheduler.start(client);
}

export function stopScheduler() {
  dailyScheduler.stop();
  log.info('Moderation scheduler stopped');
}

// ── Time helpers (UTC by default; supports tz via Intl) ──

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

// ── Tick ──

async function checkDailyRun(client) {
  const cfg = config.moderation || {};
  if (!cfg.enabled || !cfg.channelId) return;

  const tz = cfg.timezone || 'UTC';
  const today = getTodayDate(tz);
  const currentTime = getCurrentTime(tz);
  const dailyTime = normalizeTime(cfg.dailyTime || '08:00');

  if (currentTime < dailyTime) return;

  // Idempotency: skip if today's run already finished successfully (or gave up after retries)
  const state = await getCurrentState().catch(() => null);
  const lastRunDate = state?.last_run_date
    ? new Date(state.last_run_date).toISOString().slice(0, 10)
    : null;
  if (lastRunDate === today) return;

  log.info({ today, currentTime, dailyTime }, 'Triggering daily moderation report');
  try {
    await runDailyModerationReport(client);
  } catch (err) {
    log.error({ err }, 'Moderation report run threw unexpectedly');
    reportError(err, { source: 'scheduler:moderation:daily' }).catch(() => {});
  }
}

// ── Manual trigger (for /modreport command and tests) ──

export async function triggerNow(client, opts = {}) {
  log.info({ opts }, 'Manual moderation report trigger');
  return await runDailyModerationReport(client, opts);
}
