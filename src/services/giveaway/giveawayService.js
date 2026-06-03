import { query } from '../../database/connection.js';
import logger from '../../logger.js';

const log = logger.child({ module: 'giveawayService' });

export async function createGiveaway({
  prize,
  monthLabel,
  drawAt,
  entryChannelId,
  createdBy,
  windowDays = 30,
  minHours = 5.0,
  hoursWeight = 1.0,
  seedWeight = 2.0,
  voteWeight = 1,
  votesPerVoter = 2,
}) {
  const result = await query(
    `INSERT INTO giveaways (
       prize, month_label, draw_at, entry_channel_id, created_by,
       window_days, min_hours, hours_weight, seed_weight, vote_weight, votes_per_voter
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [prize, monthLabel, drawAt, entryChannelId, createdBy,
     windowDays, minHours, hoursWeight, seedWeight, voteWeight, votesPerVoter]
  );
  return getGiveawayById(result.insertId);
}

export async function getGiveawayById(id) {
  const rows = await query('SELECT * FROM giveaways WHERE id = ?', [id]);
  return rows[0] || null;
}

export async function getActiveGiveaway() {
  const rows = await query(
    `SELECT * FROM giveaways WHERE status IN ('open','voting') ORDER BY id DESC LIMIT 1`
  );
  return rows[0] || null;
}

export async function setEntryMessage(giveawayId, channelId, messageId) {
  await query(
    `UPDATE giveaways SET entry_channel_id = ?, entry_message_id = ? WHERE id = ?`,
    [channelId, messageId, giveawayId]
  );
}

export async function setVoteMessage(giveawayId, channelId, messageId) {
  await query(
    `UPDATE giveaways SET vote_channel_id = ?, vote_message_id = ?, status = 'voting' WHERE id = ?`,
    [channelId, messageId, giveawayId]
  );
}

export async function markDrawn(giveawayId, winnerUserId) {
  await query(
    `UPDATE giveaways SET status = 'drawn', winner_user_id = ?, drawn_at = NOW() WHERE id = ?`,
    [winnerUserId, giveawayId]
  );
}

export async function cancelGiveaway(giveawayId) {
  await query(`UPDATE giveaways SET status = 'cancelled' WHERE id = ?`, [giveawayId]);
}

export { log };

export async function addLinkedEntry(giveawayId, userId, steamId) {
  await query(
    `INSERT INTO giveaway_entries (giveaway_id, user_id, steam_id)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE steam_id = VALUES(steam_id)`,
    [giveawayId, userId, steamId]
  );
}

export async function upsertManualEntry(giveawayId, userId, hours, seed, addedBy) {
  await query(
    `INSERT INTO giveaway_entries (giveaway_id, user_id, manual_hours, manual_seed, added_by)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       manual_hours = VALUES(manual_hours),
       manual_seed = VALUES(manual_seed),
       added_by = VALUES(added_by)`,
    [giveawayId, userId, hours, seed, addedBy]
  );
}

export async function getEntry(giveawayId, userId) {
  const rows = await query(
    `SELECT * FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?`,
    [giveawayId, userId]
  );
  return rows[0] || null;
}

export async function listEntries(giveawayId) {
  return await query(
    `SELECT * FROM giveaway_entries WHERE giveaway_id = ? ORDER BY entered_at ASC`,
    [giveawayId]
  );
}
