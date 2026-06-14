import logger from '../../logger.js';
import config from '../../config.js';
import { createScheduler } from '../../utils/scheduler.js';
import {
  parseMapRotationMode,
  parseLayerRotation,
  fetchCfgFiles,
  validateRotation,
  hashRotation,
  hashErrors,
  readPersistedRotation,
  upsertPersistedRotation,
  readPersistedErrorHash,
  writePersistedErrorHash,
} from './layerRotationValidatorService.js';
import { buildSuccessEmbed, buildErrorEmbed } from './layerRotationValidatorEmbeds.js';
import { getServerState } from '../seeding/seedingSocket.js';
import { getServerStats } from '../serverStatus/serverStatusQueries.js';

const log = logger.child({ module: 'layerRotationValidator' });

const VALID_MODES = new Set(['LayerList', 'LayerList_Vote']);

let mode = 'sftp';
let liveMessageId = null;
let lastValidHash = null;
let lastErrorHash = null;
let lastKnownMode = null;
let resolvedServerCfgName = null;
let booted = false;
let warnedAboutUnusedMode = false;
let warnedAboutSftpMissing = false;

function getSettings() {
  return config.layerRotationValidator || null;
}

function getSftpConfig() {
  const host = process.env.SFTP_HOST;
  const user = process.env.SFTP_USER;
  const pass = process.env.SFTP_PASS;
  const path = process.env.SFTP_PATH;
  if (!host || !user || !pass || !path) return null;
  return {
    host,
    port: parseInt(process.env.SFTP_PORT || '22', 10),
    user, pass, path,
  };
}

function getSquadUtilsUrl() {
  return getSettings()?.squadUtilsUrl || process.env.SQUAD_UTILS_URL || 'https://squadutils.org/api/v3/parse';
}

async function clearChannel(client, channelId) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    log.warn({ channelId }, 'Prod channel not found - skipping clear');
    return null;
  }
  try {
    const messages = await channel.messages.fetch({ limit: 100 });
    if (messages.size > 0) {
      await channel.bulkDelete(messages, true).catch(() => {});
      const remaining = await channel.messages.fetch({ limit: 100 }).catch(() => null);
      if (remaining) {
        let oldDeleted = 0;
        for (const msg of remaining.values()) {
          await msg.delete().catch(() => {});
          oldDeleted += 1;
          await new Promise((r) => setTimeout(r, 250));
        }
        if (oldDeleted > 0) log.info({ oldDeleted }, 'Deleted messages older than bulkDelete limit');
      }
    }
    log.info({ channelId }, 'Prod channel cleared on boot');
    return channel;
  } catch (err) {
    log.warn({ err }, 'Channel clear failed (continuing)');
    return channel;
  }
}

// Best-effort resolve of the live layer + match start time from the seeding
// server socket. Any miss (no server configured, socket down, query error)
// returns nulls and the embed renders without highlight / timer.
async function readLiveLayerState() {
  const name = config.seeding?.seedingServer;
  if (!name) return { currentLayer: null, matchStartTime: null };
  const state = getServerState(name);
  if (!state?.connected) return { currentLayer: null, matchStartTime: null };
  const stats = await getServerStats(name).catch(() => ({}));
  return { currentLayer: state.currentLayer || null, matchStartTime: stats?.matchStartTime ?? null };
}

export async function replaceLiveEmbed(client, { mode: embedMode, lines, source }) {
  const settings = getSettings();
  if (!settings?.channelId) return false;
  const channel = await client.channels.fetch(settings.channelId).catch(() => null);
  if (!channel) {
    log.error({ channelId: settings.channelId }, 'Cannot fetch prod channel for embed post');
    return false;
  }
  const { currentLayer, matchStartTime } = await readLiveLayerState();
  const embed = buildSuccessEmbed({ mode: embedMode, lines, currentLayer, matchStartTime });
  const sent = await channel.send({ embeds: [embed] }).catch((err) => {
    log.error({ err }, 'Failed to send success embed');
    return null;
  });
  if (!sent) return false;
  const previousId = liveMessageId;
  liveMessageId = sent.id;
  if (previousId) {
    const old = await channel.messages.fetch(previousId).catch(() => null);
    if (old) await old.delete().catch(() => {});
  }
  try {
    await upsertPersistedRotation({
      cleanedText: lines.join('\n'),
      mode: embedMode || 'Unknown',
      source,
    });
  } catch (err) {
    log.warn({ err }, 'Failed to upsert persisted rotation');
  }
  log.info({ mode: embedMode, layers: lines.length, source }, 'Posted updated rotation embed');
  return true;
}

async function postError(client, settings, errors) {
  const alertsChannelId = config.alerts?.channelId;
  if (!alertsChannelId) {
    log.warn('config.alerts.channelId missing - cannot post rotation error');
    return;
  }
  const channel = await client.channels.fetch(alertsChannelId).catch(() => null);
  if (!channel) {
    log.error({ alertsChannelId }, 'Alerts channel not found');
    return;
  }
  const roleIds = Array.isArray(settings.errorRoleIds) ? settings.errorRoleIds : [];
  const mentions = roleIds.map((id) => `<@&${id}>`).join(' ');
  const content = `${mentions} Layer rotation failed validation`.trim();
  const embed = buildErrorEmbed({ errors });
  await channel.send({
    content,
    embeds: [embed],
    allowedMentions: { roles: roleIds },
  }).catch((err) => log.error({ err }, 'Failed to send rotation-error alert'));
}

async function restoreFromPersistence(client, settings) {
  try {
    lastErrorHash = await readPersistedErrorHash();
  } catch (err) {
    log.warn({ err }, 'Failed to read persisted error hash');
  }
  let row = null;
  try {
    row = await readPersistedRotation();
  } catch (err) {
    log.warn({ err }, 'Failed to read persisted rotation');
    return;
  }
  if (!row) return;
  const { lines } = parseLayerRotation(row.cleanedText);
  if (lines.length === 0) return;
  lastKnownMode = row.mode || lastKnownMode;
  const posted = await replaceLiveEmbed(client, { mode: row.mode || 'Unknown', lines, source: row.source });
  if (posted) {
    lastValidHash = hashRotation(row.mode || 'Unknown', lines.join('\n'));
  }
}

// Re-post the live rotation embed using the persisted rotation plus the latest
// live layer/timer. Called when NEW_GAME fires for the seeding server, and by
// the /layer-rotation command. Returns a status for the command to report.
export async function refreshLiveLayerHighlight(client) {
  const settings = getSettings();
  if (!settings?.enabled) return { ok: false, reason: 'validator disabled in settings' };
  if (!settings.channelId) return { ok: false, reason: 'no channel configured' };

  let row = null;
  try {
    row = await readPersistedRotation();
  } catch (err) {
    log.warn({ err }, 'refreshLiveLayerHighlight: failed to read persisted rotation');
    return { ok: false, reason: 'failed to read persisted rotation' };
  }
  if (!row) return { ok: false, reason: 'no rotation cached yet (wait for the next 5-minute fetch)' };

  const { lines } = parseLayerRotation(row.cleanedText);
  if (lines.length === 0) return { ok: false, reason: 'cached rotation is empty' };

  const posted = await replaceLiveEmbed(client, {
    mode: row.mode || lastKnownMode || 'Unknown',
    lines,
    source: row.source || 'live-refresh',
  });
  if (posted) lastValidHash = hashRotation(row.mode || lastKnownMode || 'Unknown', lines.join('\n'));
  return posted ? { ok: true } : { ok: false, reason: 'failed to post embed' };
}

async function tickSftpMode(client, settings) {
  const sftpConfig = getSftpConfig();
  if (!sftpConfig) {
    if (!warnedAboutSftpMissing) {
      log.warn('SFTP env vars missing - SFTP mode inactive');
      warnedAboutSftpMissing = true;
    }
    return;
  }

  let cfgs;
  try {
    cfgs = await fetchCfgFiles(sftpConfig, {
      serverCfgName: settings.serverCfgName || 'Server.cfg',
      layerRotationName: settings.layerRotationName || 'LayerRotation.cfg',
      cachedServerCfgName: resolvedServerCfgName,
    });
    resolvedServerCfgName = cfgs.resolvedServerCfgName;
  } catch (err) {
    log.warn({ err: err?.message }, 'SFTP fetch failed - skipping tick');
    return;
  }

  const parsedMode = parseMapRotationMode(cfgs.serverCfgText);
  if (!VALID_MODES.has(parsedMode)) {
    if (!warnedAboutUnusedMode) {
      log.warn({ mode: parsedMode }, 'MapRotationMode is not LayerList or LayerList_Vote - skipping');
      warnedAboutUnusedMode = true;
    }
    return;
  }
  warnedAboutUnusedMode = false;
  lastKnownMode = parsedMode;

  const { cleanedText, lines } = parseLayerRotation(cfgs.layerRotationText);
  const hash = hashRotation(parsedMode, cleanedText);
  if (hash === lastValidHash) return;

  const result = await validateRotation(getSquadUtilsUrl(), cleanedText);
  if (result.fetchError) {
    log.warn({ fetchError: result.fetchError }, 'Squadutils API call failed - skipping tick');
    return;
  }

  if (!result.ok) {
    const errHash = hashErrors(result.errors);
    if (errHash === lastErrorHash) return;
    lastErrorHash = errHash;
    await writePersistedErrorHash(errHash).catch((err) =>
      log.warn({ err }, 'Failed to persist error hash')
    );
    await postError(client, settings, result.errors);
    return;
  }

  const posted = await replaceLiveEmbed(client, { mode: parsedMode, lines, source: 'sftp' });
  if (posted) {
    lastErrorHash = null;
    await writePersistedErrorHash(null).catch((err) =>
      log.warn({ err }, 'Failed to clear persisted error hash')
    );
    lastValidHash = hash;
  }
}

async function tickChannelMode(client, settings) {
  const sftpConfig = getSftpConfig();
  if (!sftpConfig) {
    if (!warnedAboutSftpMissing) {
      log.warn('SFTP env vars missing - Channel mode running without mode-badge refresh');
      warnedAboutSftpMissing = true;
    }
    return;
  }

  let cfgs;
  try {
    cfgs = await fetchCfgFiles(sftpConfig, {
      serverCfgName: settings.serverCfgName || 'Server.cfg',
      layerRotationName: settings.layerRotationName || 'LayerRotation.cfg',
      cachedServerCfgName: resolvedServerCfgName,
      serverCfgOnly: true,
    });
    resolvedServerCfgName = cfgs.resolvedServerCfgName;
  } catch (err) {
    log.warn({ err: err?.message }, 'SFTP fetch (Server.cfg only) failed - keeping cached mode');
    return;
  }

  const parsedMode = parseMapRotationMode(cfgs.serverCfgText);
  if (!VALID_MODES.has(parsedMode)) {
    log.warn({ mode: parsedMode }, 'MapRotationMode is not LayerList/Vote - badge will say Unknown');
    return;
  }

  if (parsedMode === lastKnownMode) return;
  const previousMode = lastKnownMode;
  lastKnownMode = parsedMode;

  if (previousMode === null) {
    return;
  }

  let row = null;
  try {
    row = await readPersistedRotation();
  } catch (err) {
    log.warn({ err }, 'Persisted rotation read failed during mode-refresh');
    return;
  }
  if (!row) return;
  const { lines } = parseLayerRotation(row.cleanedText);
  if (lines.length === 0) return;
  const posted = await replaceLiveEmbed(client, { mode: parsedMode, lines, source: row.source || 'channel' });
  if (posted) {
    lastValidHash = hashRotation(parsedMode, lines.join('\n'));
  }
}

async function tick(client) {
  const settings = getSettings();
  if (!settings?.enabled || !settings.channelId) return;

  if (!booted) {
    await clearChannel(client, settings.channelId);
    await restoreFromPersistence(client, settings);
    booted = true;
  }

  if (mode === 'channel') {
    await tickChannelMode(client, settings);
  } else {
    await tickSftpMode(client, settings);
  }
}

const scheduler = createScheduler({
  name: 'layerRotationValidator',
  intervalMs: 5 * 60 * 1000,
  tick,
});

export async function startScheduler(client) {
  const settings = getSettings();
  if (!settings?.enabled) {
    log.info('layerRotationValidator disabled in settings - not starting');
    return;
  }
  if (!settings.channelId) {
    log.warn('layerRotationValidator.channelId missing - not starting');
    return;
  }
  const envSource = (process.env.LAYER_ROTATION_SOURCE || '').toLowerCase();
  if (envSource === 'channel') {
    mode = 'channel';
  } else if (envSource === 'sftp' || envSource === '') {
    mode = 'sftp';
  } else {
    log.warn({ LAYER_ROTATION_SOURCE: envSource }, 'Unknown LAYER_ROTATION_SOURCE value, defaulting to sftp');
    mode = 'sftp';
  }
  log.info({ mode }, `layerRotationValidator started (5-minute polling, source=${mode})`);
  scheduler.start(client);
}

export function stopScheduler() {
  scheduler.stop();
  mode = 'sftp';
  liveMessageId = null;
  lastValidHash = null;
  lastErrorHash = null;
  lastKnownMode = null;
  resolvedServerCfgName = null;
  booted = false;
  warnedAboutUnusedMode = false;
  warnedAboutSftpMissing = false;
}

export function getMode() { return mode; }
export function getChannelId() { return getSettings()?.channelId || null; }
export function getRoleIds() { return getSettings()?.errorRoleIds || []; }
export function getLastValidHash() { return lastValidHash; }
export function setLastValidHash(h) { lastValidHash = h; }
export function getLastKnownMode() { return lastKnownMode; }
