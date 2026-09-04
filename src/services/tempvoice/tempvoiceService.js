import { query } from '../../database/connection.js';
import logger from '../../logger.js';

const log = logger.child({ module: 'tempvoice-service' });

// ── Config (singleton row, like seeding_config) ──

export async function getConfig() {
  const rows = await query('SELECT * FROM temp_voice_config WHERE id = 1');
  if (rows.length) return rows[0];
  await query('INSERT IGNORE INTO temp_voice_config (id) VALUES (1)');
  const inserted = await query('SELECT * FROM temp_voice_config WHERE id = 1');
  return inserted[0];
}

export async function saveConfig(triggerChannelId, categoryId, logChannelId) {
  await query(
    `INSERT INTO temp_voice_config (id, trigger_channel_id, category_id, log_channel_id)
     VALUES (1, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       trigger_channel_id = VALUES(trigger_channel_id),
       category_id = VALUES(category_id),
       log_channel_id = VALUES(log_channel_id)`,
    [triggerChannelId, categoryId, logChannelId || null],
  );
}

export async function setDefaultAllowVad(value) {
  const flag = value ? 1 : 0;
  await query(
    `INSERT INTO temp_voice_config (id, default_allow_vad)
     VALUES (1, ?)
     ON DUPLICATE KEY UPDATE default_allow_vad = VALUES(default_allow_vad)`,
    [flag],
  );
}

export async function setMaxChannelsPerUser(max) {
  const n = Math.max(1, Math.min(10, Math.floor(Number(max)) || 1));
  await query(
    `INSERT INTO temp_voice_config (id, max_channels_per_user)
     VALUES (1, ?)
     ON DUPLICATE KEY UPDATE max_channels_per_user = VALUES(max_channels_per_user)`,
    [n],
  );
  return n;
}

// ── Temp channels CRUD ──

export async function createTempChannel(channelId, ownerId, guildId, panelMessageId) {
  await query(
    'INSERT INTO temp_channels (channel_id, owner_id, guild_id, panel_message_id) VALUES (?, ?, ?, ?)',
    [channelId, ownerId, guildId, panelMessageId || null],
  );
}

export async function deleteTempChannel(channelId) {
  await query('DELETE FROM temp_channels WHERE channel_id = ?', [channelId]);
}

export async function getTempChannel(channelId) {
  const rows = await query('SELECT * FROM temp_channels WHERE channel_id = ?', [channelId]);
  return rows[0] || null;
}

export async function getTempChannelsByOwner(ownerId) {
  return query('SELECT * FROM temp_channels WHERE owner_id = ?', [ownerId]);
}

export async function getAllTempChannels() {
  return query('SELECT * FROM temp_channels');
}

export async function updateOwner(channelId, newOwnerId) {
  await query('UPDATE temp_channels SET owner_id = ? WHERE channel_id = ?', [newOwnerId, channelId]);
}

export async function updatePanelMessageId(channelId, messageId) {
  await query('UPDATE temp_channels SET panel_message_id = ? WHERE channel_id = ?', [messageId, channelId]);
}

export async function touchActivity(channelId) {
  await query('UPDATE temp_channels SET last_activity = CURRENT_TIMESTAMP WHERE channel_id = ?', [channelId]);
}

export async function getInactiveChannels(hoursThreshold) {
  return query(
    'SELECT * FROM temp_channels WHERE last_activity < DATE_SUB(NOW(), INTERVAL ? HOUR)',
    [hoursThreshold],
  );
}

// ── User presets ──

export async function getPreset(userId, guildId) {
  const rows = await query(
    'SELECT * FROM temp_voice_presets WHERE user_id = ? AND guild_id = ?',
    [userId, guildId],
  );
  return rows[0] || null;
}

export async function savePreset(userId, guildId, settings) {
  await query(
    `INSERT INTO temp_voice_presets (user_id, guild_id, channel_name, bitrate, region, user_limit, is_locked, is_invisible, is_chat_closed, is_dnd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       channel_name = VALUES(channel_name),
       bitrate = VALUES(bitrate),
       region = VALUES(region),
       user_limit = VALUES(user_limit),
       is_locked = VALUES(is_locked),
       is_invisible = VALUES(is_invisible),
       is_chat_closed = VALUES(is_chat_closed),
       is_dnd = VALUES(is_dnd)`,
    [
      userId, guildId,
      settings.channel_name ?? null,
      settings.bitrate ?? null,
      settings.region ?? null,
      settings.user_limit ?? null,
      settings.is_locked ? 1 : 0,
      settings.is_invisible ? 1 : 0,
      settings.is_chat_closed ? 1 : 0,
      settings.is_dnd ? 1 : 0,
    ],
  );
}

const PRESET_FIELDS = new Set([
  'channel_name', 'bitrate', 'region', 'user_limit',
  'is_locked', 'is_invisible', 'is_chat_closed', 'is_dnd',
]);

export async function updatePresetField(userId, guildId, field, value) {
  if (!PRESET_FIELDS.has(field)) throw new Error(`Invalid preset field: ${field}`);
  await query(
    `INSERT INTO temp_voice_presets (user_id, guild_id, ${field})
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE ${field} = VALUES(${field})`,
    [userId, guildId, value],
  );
}

function jsonIds(ids) {
  return JSON.stringify(Array.isArray(ids) ? ids.map(String) : []);
}

export async function updateChannelSnapshot(channelId, snap) {
  await query(
    `UPDATE temp_channels SET
       channel_name = ?,
       user_limit = ?,
       bitrate = ?,
       region = ?,
       is_locked = ?,
       is_invisible = ?,
       is_chat_closed = ?,
       is_dnd = ?,
       member_count = ?,
       member_ids = ?,
       trusted_ids = ?,
       blocked_ids = ?,
       snapshot_at = CURRENT_TIMESTAMP
     WHERE channel_id = ?`,
    [
      snap.channelName ?? null,
      snap.userLimit ?? 0,
      snap.bitrate ?? null,
      snap.region ?? null,
      snap.isLocked ? 1 : 0,
      snap.isInvisible ? 1 : 0,
      snap.isChatClosed ? 1 : 0,
      snap.isDnd ? 1 : 0,
      snap.memberCount ?? 0,
      jsonIds(snap.memberIds),
      jsonIds(snap.trustedIds),
      jsonIds(snap.blockedIds),
      channelId,
    ],
  );
}

export async function recordEvent({ eventType, channelId = null, channelName = null, actorId = null, ownerId = null, details = null }) {
  await query(
    `INSERT INTO temp_voice_events (event_type, channel_id, channel_name, actor_id, owner_id, details)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      eventType,
      channelId,
      channelName,
      actorId,
      ownerId,
      details == null ? null : JSON.stringify(details),
    ],
  );
}

export async function pruneEvents(days = 90) {
  const n = Math.max(7, Math.floor(Number(days) || 90));
  const result = await query(
    'DELETE FROM temp_voice_events WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
    [n],
  );
  return result?.affectedRows ?? 0;
}
