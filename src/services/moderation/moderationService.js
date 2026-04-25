import { query } from '../../database/connection.js';
import config from '../../config.js';
import logger from '../../logger.js';
import { reportError } from '../admin/errorAlertService.js';
import { getAnthropicClient, isAnthropicAvailable } from '../ai/anthropicClient.js';
import { buildSystemPrompt, buildUserBatchText } from './moderationPrompt.js';
import {
  buildReportPayload,
  buildZeroViolationsPayload,
  buildErrorPayload,
} from './moderationEmbeds.js';

const log = logger.child({ module: 'moderation' });

const MODEL = 'claude-sonnet-4-6';
const MAX_DAILY_RETRIES = 3;

const VALID_CATEGORIES = new Set([
  'racism', 'recruiting', 'abuse', 'harassment', 'threats',
  'advertising', 'drama', 'other',
]);

let cachedServerId = null;
let dailyRetryCount = 0;
let lastRetryDate = null;

// ─────────────────────────────────────────────
// Server resolution
// ─────────────────────────────────────────────

async function resolveProductionServerId(configuredName) {
  if (cachedServerId != null) return cachedServerId;

  if (configuredName) {
    const rows = await query(
      'SELECT id FROM squadjs_servers WHERE name = ?',
      [configuredName],
      'squadjs',
    );
    if (rows.length > 0) {
      cachedServerId = rows[0].id;
      log.info({ name: configuredName, id: cachedServerId }, 'Resolved production server_id by name');
      return cachedServerId;
    }
    log.warn({ configuredName }, 'No squadjs_servers row matches productionServerName; falling back');
  }

  const rows = await query(
    `SELECT s.id FROM squadjs_servers s
     JOIN squadjs_matches m ON m.server_id = s.id
     ORDER BY m.start_time DESC LIMIT 1`,
    [],
    'squadjs',
  );
  if (rows.length > 0) {
    cachedServerId = rows[0].id;
    log.info({ id: cachedServerId }, 'Resolved production server_id via latest-match fallback');
    return cachedServerId;
  }
  return null;
}

async function getServerName(serverId) {
  const rows = await query(
    'SELECT name FROM squadjs_servers WHERE id = ?',
    [serverId],
    'squadjs',
  );
  return rows[0]?.name || `server #${serverId}`;
}

// ─────────────────────────────────────────────
// Window fetch
// ─────────────────────────────────────────────

async function fetchChatWindow(serverId, windowEndDate, windowHours) {
  return await query(
    `SELECT cm.id AS message_id, cm.server_id, cm.match_id, cm.player_id,
            cm.time AS message_time, cm.chat_type, cm.player_name, cm.message,
            p.eos_id, p.steam_id, p.name AS canonical_name, p.prefix
     FROM squadjs_chat_messages cm
     LEFT JOIN squadjs_players p ON p.id = cm.player_id
     WHERE cm.server_id = ?
       AND cm.time >= DATE_SUB(?, INTERVAL ? HOUR)
       AND cm.time <  ?
       AND cm.chat_type IN ('ChatAll','ChatTeam','ChatSquad','ChatAdmin')
     ORDER BY cm.time ASC`,
    [serverId, windowEndDate, windowHours, windowEndDate],
    'squadjs',
  );
}

// ─────────────────────────────────────────────
// State persistence
// ─────────────────────────────────────────────

async function getModerationState() {
  const rows = await query('SELECT * FROM moderation_state WHERE id = 1');
  return rows[0] || null;
}

async function setModerationState({ runDate, status, message }) {
  await query(
    `INSERT INTO moderation_state (id, last_run_date, last_run_at, last_run_status, last_run_message)
     VALUES (1, ?, NOW(), ?, ?)
     ON DUPLICATE KEY UPDATE
       last_run_date = VALUES(last_run_date),
       last_run_at = VALUES(last_run_at),
       last_run_status = VALUES(last_run_status),
       last_run_message = VALUES(last_run_message)`,
    [runDate, status, message ?? null],
  );
}

// ─────────────────────────────────────────────
// AI call
// ─────────────────────────────────────────────

function parseAiJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function normaliseFlag(raw, lookup) {
  if (!raw || raw.message_id == null) return null;
  const src = lookup.get(Number(raw.message_id));
  if (!src) return null;

  const category = VALID_CATEGORIES.has(raw.category) ? raw.category : 'other';
  return {
    message_id: src.message_id,
    server_id: src.server_id,
    player_id: src.player_id ?? null,
    eos_id: src.eos_id ?? null,
    steam_id: src.steam_id ?? null,
    player_name: src.player_name,
    chat_type: src.chat_type,
    message_time: src.message_time,
    message_text: src.message,
    category,
    rule_cited: raw.rule_cited ? String(raw.rule_cited).slice(0, 255) : null,
    recommended_action: raw.recommended_action ? String(raw.recommended_action).slice(0, 500) : null,
    ai_reasoning: raw.reasoning ? String(raw.reasoning) : null,
  };
}

async function runClaudeChunk(anthropic, systemPrompt, batch, maxOutputTokens) {
  const userText = buildUserBatchText(batch);
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: maxOutputTokens,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userText }],
  });

  log.info({
    chunkSize: batch.length,
    inputTokens: response.usage?.input_tokens,
    outputTokens: response.usage?.output_tokens,
    cacheCreationInputTokens: response.usage?.cache_creation_input_tokens,
    cacheReadInputTokens: response.usage?.cache_read_input_tokens,
  }, 'Moderation AI chunk completed');

  const text = response.content?.[0]?.text;
  const parsed = parseAiJson(text);
  if (!parsed) throw new Error('AI returned non-JSON or unparseable response');
  return parsed;
}

function chunkArray(arr, size) {
  if (arr.length <= size) return [arr];
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

async function classifyMessages(messages, { chunkThreshold, maxOutputTokens }) {
  const anthropic = getAnthropicClient();
  const systemPrompt = buildSystemPrompt();

  const lookup = new Map(messages.map(m => [Number(m.message_id), m]));
  const chunks = messages.length > chunkThreshold
    ? chunkArray(messages, Math.min(chunkThreshold, 3000))
    : [messages];

  const definite = [];
  const possible = [];

  for (const chunk of chunks) {
    const parsed = await runClaudeChunk(anthropic, systemPrompt, chunk, maxOutputTokens);
    const defArr = Array.isArray(parsed.definite) ? parsed.definite : [];
    const posArr = Array.isArray(parsed.possible) ? parsed.possible : [];
    for (const raw of defArr) {
      const f = normaliseFlag(raw, lookup);
      if (!f) continue;
      f.severity = 'definite';
      definite.push(f);
    }
    for (const raw of posArr) {
      const f = normaliseFlag(raw, lookup);
      if (!f) continue;
      f.severity = 'possible';
      possible.push(f);
    }
  }

  // Dedupe by message_id (higher severity wins if duplicated across chunks)
  const seen = new Set();
  const dedupedDefinite = [];
  for (const f of definite) {
    if (seen.has(f.message_id)) continue;
    seen.add(f.message_id);
    dedupedDefinite.push(f);
  }
  const dedupedPossible = [];
  for (const f of possible) {
    if (seen.has(f.message_id)) continue;
    seen.add(f.message_id);
    dedupedPossible.push(f);
  }

  return { definite: dedupedDefinite, possible: dedupedPossible };
}

// ─────────────────────────────────────────────
// Persistence of flags
// ─────────────────────────────────────────────

async function persistFlags(runDate, flags) {
  for (const f of flags) {
    try {
      await query(
        `INSERT INTO moderation_flags
          (run_date, server_id, squadjs_message_id, player_id, eos_id, steam_id,
           player_name, chat_type, message_time, message_text,
           severity, category, rule_cited, recommended_action, ai_reasoning)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           severity = VALUES(severity),
           category = VALUES(category),
           rule_cited = VALUES(rule_cited),
           recommended_action = VALUES(recommended_action),
           ai_reasoning = VALUES(ai_reasoning)`,
        [
          runDate, f.server_id, f.message_id, f.player_id, f.eos_id, f.steam_id,
          f.player_name, f.chat_type, f.message_time, f.message_text,
          f.severity, f.category, f.rule_cited, f.recommended_action, f.ai_reasoning,
        ],
      );
    } catch (err) {
      log.warn({ err, messageId: f.message_id }, 'Failed to persist moderation flag');
    }
  }
}

// ─────────────────────────────────────────────
// Repeat offenders
// ─────────────────────────────────────────────

export async function getRecentFlagsByPlayer(days) {
  const summary = await query(
    `SELECT COALESCE(steam_id, eos_id, player_name) AS player_key,
            steam_id, eos_id, MAX(player_name) AS player_name,
            COUNT(*) AS total_flags,
            SUM(severity = 'definite') AS definite_count,
            SUM(severity = 'possible') AS possible_count,
            MAX(message_time) AS last_flag_at
     FROM moderation_flags
     WHERE run_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
     GROUP BY player_key, steam_id, eos_id
     HAVING total_flags >= 2
     ORDER BY definite_count DESC, total_flags DESC
     LIMIT 50`,
    [days],
  );

  const out = [];
  for (const row of summary) {
    let whereClause, whereParams;
    if (row.steam_id) {
      whereClause = 'steam_id = ?';
      whereParams = [row.steam_id];
    } else if (row.eos_id) {
      whereClause = 'eos_id = ? AND steam_id IS NULL';
      whereParams = [row.eos_id];
    } else {
      whereClause = 'player_name = ? AND steam_id IS NULL AND eos_id IS NULL';
      whereParams = [row.player_name];
    }

    const recent = await query(
      `SELECT run_date, severity, category, message_text, message_time
       FROM moderation_flags
       WHERE ${whereClause}
         AND run_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       ORDER BY run_date DESC, message_time DESC
       LIMIT 20`,
      [...whereParams, days],
    );
    out.push({
      player_name: row.player_name,
      steam_id: row.steam_id,
      eos_id: row.eos_id,
      total_flags: Number(row.total_flags),
      definite_count: Number(row.definite_count),
      possible_count: Number(row.possible_count),
      last_flag_at: row.last_flag_at,
      recent,
    });
  }
  return out;
}

// ─────────────────────────────────────────────
// Failure-aware sender
// ─────────────────────────────────────────────

async function sendToChannel(client, channelId, payload) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    log.error({ channelId }, 'Moderation report channel not found');
    return false;
  }
  try {
    await channel.send(payload);
    return true;
  } catch (err) {
    log.error({ err, channelId }, 'Failed to send moderation report');
    reportError(err, { source: 'moderation:send' }).catch(() => {});
    return false;
  }
}

function bumpRetry(runDate) {
  if (lastRetryDate !== runDate) {
    lastRetryDate = runDate;
    dailyRetryCount = 0;
  }
  dailyRetryCount += 1;
  return dailyRetryCount;
}

// ─────────────────────────────────────────────
// Public: run report
// ─────────────────────────────────────────────

/**
 * Run the daily moderation report.
 * @param {object} client - discord.js Client
 * @param {object} [opts] - { force?: boolean, windowEndDate?: Date }
 * @returns {Promise<{status: string, definite?: number, possible?: number, error?: string}>}
 */
export async function runDailyModerationReport(client, opts = {}) {
  const cfg = config.moderation || {};
  if (!cfg.channelId) {
    log.warn('Moderation channelId not configured; skipping');
    return { status: 'skipped', error: 'channelId missing' };
  }

  if (!isAnthropicAvailable()) {
    log.warn('Anthropic API key not configured; skipping moderation report');
    return { status: 'skipped', error: 'ANTHROPIC_API_KEY missing' };
  }

  const windowEndDate = opts.windowEndDate || new Date();
  const runDate = windowEndDate.toISOString().slice(0, 10);
  const windowEndTime = windowEndDate.toISOString().slice(11, 16);
  const windowHours = cfg.windowHours || 24;
  const windowStart = new Date(windowEndDate.getTime() - windowHours * 3600 * 1000);
  const windowStartIso = windowStart.toISOString().slice(0, 16).replace('T', ' ');

  // 1. Resolve server
  let serverId;
  try {
    serverId = await resolveProductionServerId(cfg.productionServerName);
  } catch (err) {
    log.error({ err }, 'Server resolution failed');
    bumpRetry(runDate);
    await setModerationState({ runDate: null, status: 'db_failed', message: `server resolution: ${err.message}` });
    await sendToChannel(client, cfg.channelId, buildErrorPayload({ runDate, errorMessage: err.message, stage: 'server_lookup' }));
    return { status: 'db_failed', error: err.message };
  }
  if (serverId == null) {
    const msg = 'No production server_id resolved';
    log.warn(msg);
    bumpRetry(runDate);
    await setModerationState({ runDate: null, status: 'db_failed', message: msg });
    await sendToChannel(client, cfg.channelId, buildErrorPayload({ runDate, errorMessage: msg, stage: 'server_lookup' }));
    return { status: 'db_failed', error: msg };
  }

  const serverName = await getServerName(serverId);
  const server = { id: serverId, name: serverName };

  // 2. Fetch window
  let messages;
  try {
    messages = await fetchChatWindow(serverId, windowEndDate, windowHours);
  } catch (err) {
    log.error({ err }, 'Chat window fetch failed');
    bumpRetry(runDate);
    await setModerationState({ runDate: null, status: 'db_failed', message: `fetchWindow: ${err.message}` });
    await sendToChannel(client, cfg.channelId, buildErrorPayload({ runDate, errorMessage: err.message, stage: 'fetch_chat' }));
    return { status: 'db_failed', error: err.message };
  }

  const uniquePlayers = new Set(messages.map(m => m.steam_id || m.eos_id || m.player_name)).size;
  const stats = {
    totalMessages: messages.length,
    uniquePlayers,
    windowEndTime,
    windowStartIso,
  };

  log.info({ runDate, serverId, totalMessages: messages.length, uniquePlayers }, 'Moderation window fetched');

  // 3. Zero-message branch — no AI call needed
  if (messages.length === 0) {
    const payload = buildZeroViolationsPayload({ runDate, server, stats, model: MODEL });
    await sendToChannel(client, cfg.channelId, payload);
    await setModerationState({ runDate, status: 'no_chat', message: 'no messages in window' });
    dailyRetryCount = 0;
    return { status: 'no_chat', definite: 0, possible: 0 };
  }

  // 4. Classify
  let classified;
  try {
    classified = await classifyMessages(messages, {
      chunkThreshold: cfg.chunkThresholdMessages || 3500,
      maxOutputTokens: cfg.maxOutputTokens || 4000,
    });
  } catch (err) {
    log.error({ err }, 'AI classification failed');
    const retries = bumpRetry(runDate);
    const giveUp = retries >= MAX_DAILY_RETRIES;
    await setModerationState({
      runDate: giveUp ? runDate : null,
      status: 'ai_failed',
      message: `${err.message} (attempt ${retries}/${MAX_DAILY_RETRIES})`,
    });
    await sendToChannel(client, cfg.channelId, buildErrorPayload({
      runDate,
      errorMessage: `${err.message} (attempt ${retries}/${MAX_DAILY_RETRIES}${giveUp ? ' — giving up for today' : ''})`,
      stage: 'ai_call',
    }));
    return { status: 'ai_failed', error: err.message };
  }

  const { definite, possible } = classified;

  // 5. Persist flags
  try {
    if (definite.length + possible.length > 0) {
      await persistFlags(runDate, [...definite, ...possible]);
    }
  } catch (err) {
    log.warn({ err }, 'Persisting flags partially failed');
    reportError(err, { source: 'moderation:persist' }).catch(() => {});
  }

  // 6. Repeat-offender lookup
  let repeatOffenders = [];
  try {
    repeatOffenders = await getRecentFlagsByPlayer(cfg.repeatOffenderLookbackDays || 30);
  } catch (err) {
    log.warn({ err }, 'Repeat-offender lookup failed; continuing');
  }

  // 7. Build + send report
  const payload = (definite.length + possible.length === 0)
    ? buildZeroViolationsPayload({ runDate, server, stats, model: MODEL })
    : buildReportPayload({ runDate, server, stats, definite, possible, repeatOffenders, model: MODEL });

  const sent = await sendToChannel(client, cfg.channelId, payload);

  await setModerationState({
    runDate,
    status: sent ? 'ok' : 'partial',
    message: sent ? `definite=${definite.length} possible=${possible.length}` : 'classification ok but channel send failed',
  });
  dailyRetryCount = 0;

  return { status: sent ? 'ok' : 'partial', definite: definite.length, possible: possible.length };
}

export async function getCurrentState() {
  return await getModerationState();
}
