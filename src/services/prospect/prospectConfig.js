import { query } from '../../database/connection.js';
import config from '../../config.js';
import logger from '../../logger.js';

const log = logger.child({ module: 'prospectConfig' });

export const DEFAULT_PROSPECT_CONFIG = {
  voteStartHours: 6,
  voteAcceptHours: 16,
  periodDays: 28,
  cooldownDays: 28,
  minYesVotes: 10,
  minYesRate: 0.8,
};

export function configFromRow(row) {
  if (!row) return { ...DEFAULT_PROSPECT_CONFIG };
  return {
    voteStartHours: Number(row.vote_start_hours) || DEFAULT_PROSPECT_CONFIG.voteStartHours,
    voteAcceptHours: Number(row.vote_accept_hours) || DEFAULT_PROSPECT_CONFIG.voteAcceptHours,
    periodDays: Number(row.period_days) || DEFAULT_PROSPECT_CONFIG.periodDays,
    cooldownDays: Number(row.cooldown_days) || DEFAULT_PROSPECT_CONFIG.cooldownDays,
    minYesVotes: Number(row.min_yes_votes) || DEFAULT_PROSPECT_CONFIG.minYesVotes,
    minYesRate: Number(row.min_yes_rate) || DEFAULT_PROSPECT_CONFIG.minYesRate,
  };
}

export function applyCooldownMessage(expiresAt) {
  const unix = Math.floor(new Date(expiresAt).getTime() / 1000);
  return `You cannot apply again yet. You can apply <t:${unix}:R>.`;
}

function firstInsertDefaults() {
  const file = config.prospects || {};
  return {
    voteStartHours: file.voteStartHours ?? DEFAULT_PROSPECT_CONFIG.voteStartHours,
    voteAcceptHours: file.voteAcceptHours ?? DEFAULT_PROSPECT_CONFIG.voteAcceptHours,
    periodDays: file.periodDays ?? DEFAULT_PROSPECT_CONFIG.periodDays,
    cooldownDays: file.cooldownDays ?? DEFAULT_PROSPECT_CONFIG.cooldownDays,
    minYesVotes: file.minYesVotes ?? DEFAULT_PROSPECT_CONFIG.minYesVotes,
    minYesRate: file.minYesRate ?? DEFAULT_PROSPECT_CONFIG.minYesRate,
  };
}

export async function getProspectConfig() {
  try {
    let rows = await query('SELECT * FROM prospect_config WHERE id = 1');
    if (!rows[0]) {
      const d = firstInsertDefaults();
      await query(
        `INSERT IGNORE INTO prospect_config
           (id, vote_start_hours, vote_accept_hours, period_days, cooldown_days, min_yes_votes, min_yes_rate)
         VALUES (1, ?, ?, ?, ?, ?, ?)`,
        [d.voteStartHours, d.voteAcceptHours, d.periodDays, d.cooldownDays, d.minYesVotes, d.minYesRate]
      );
      rows = await query('SELECT * FROM prospect_config WHERE id = 1');
    }
    return configFromRow(rows[0]);
  } catch (err) {
    log.warn({ err }, 'Failed to read prospect_config, using defaults');
    return configFromRow(null);
  }
}

export async function getActiveCooldown(userId) {
  const rows = await query(
    'SELECT * FROM prospect_cooldowns WHERE user_id = ? AND expires_at > NOW() ORDER BY expires_at DESC LIMIT 1',
    [userId]
  );
  return rows[0] || null;
}

export async function upsertCooldown({ userId, expiresAt, createdBy, reason = null, prospectId = null }) {
  const existing = await getActiveCooldown(userId);
  if (existing) {
    await query(
      `UPDATE prospect_cooldowns
          SET expires_at = ?, created_by = ?, reason = ?, prospect_id = ?
        WHERE id = ?`,
      [expiresAt, createdBy, reason, prospectId, existing.id]
    );
    return { ...existing, expires_at: expiresAt, created_by: createdBy, reason, prospect_id: prospectId };
  }
  const result = await query(
    `INSERT INTO prospect_cooldowns (user_id, expires_at, created_by, reason, prospect_id)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, expiresAt, createdBy, reason, prospectId]
  );
  return { id: result.insertId, user_id: userId, expires_at: expiresAt, created_by: createdBy, reason, prospect_id: prospectId };
}
