import { query } from '../../database/connection.js';
import logger from '../../logger.js';
import { getPlaytime } from '../playtimeService.js';
import { computeTickets } from './giveawayMath.js';

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

export async function countEntries(giveawayId) {
  const rows = await query(
    `SELECT COUNT(*) AS n FROM giveaway_entries WHERE giveaway_id = ?`,
    [giveawayId]
  );
  return Number(rows[0]?.n) || 0;
}

export async function countVotesByVoter(giveawayId, voterId) {
  const rows = await query(
    `SELECT COUNT(*) AS n FROM giveaway_votes WHERE giveaway_id = ? AND voter_id = ?`,
    [giveawayId, voterId]
  );
  return Number(rows[0]?.n) || 0;
}

export async function countVotesForTarget(giveawayId, targetId) {
  const rows = await query(
    `SELECT COUNT(*) AS n FROM giveaway_votes WHERE giveaway_id = ? AND target_id = ?`,
    [giveawayId, targetId]
  );
  return Number(rows[0]?.n) || 0;
}

export async function getVoteCountsByTarget(giveawayId) {
  const rows = await query(
    `SELECT target_id AS targetId, COUNT(*) AS n
       FROM giveaway_votes
      WHERE giveaway_id = ?
      GROUP BY target_id`,
    [giveawayId]
  );
  const map = new Map();
  for (const row of rows) map.set(row.targetId, Number(row.n));
  return map;
}

/**
 * Attempts to insert a vote. Returns:
 *   { ok: true } on success
 *   { ok: false, reason: 'cap' } if voter has hit votes_per_voter
 *   { ok: false, reason: 'duplicate' } if voter already voted for this target
 *   { ok: false, reason: 'self' } if voter tried to vote for themselves
 */
export async function castVote(giveaway, voterId, targetId) {
  if (voterId === targetId) return { ok: false, reason: 'self' };

  const used = await countVotesByVoter(giveaway.id, voterId);
  if (used >= giveaway.votes_per_voter) return { ok: false, reason: 'cap' };

  try {
    await query(
      `INSERT INTO giveaway_votes (giveaway_id, voter_id, target_id) VALUES (?, ?, ?)`,
      [giveaway.id, voterId, targetId]
    );
    return { ok: true };
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY' || err.errno === 1062) {
      return { ok: false, reason: 'duplicate' };
    }
    log.error({ err, giveawayId: giveaway.id, voterId, targetId }, 'castVote failed');
    throw err;
  }
}

/**
 * Returns entries with computed ticket counts, sorted desc.
 * windowStartIso is the start date for the SquadJS lookup window (YYYY-MM-DD).
 */
export async function computeLeaderboard(giveaway, windowStartIso) {
  const entries = await listEntries(giveaway.id);
  const voteCounts = await getVoteCountsByTarget(giveaway.id);

  const weights = {
    hours: Number(giveaway.hours_weight),
    seed: Number(giveaway.seed_weight),
    vote: Number(giveaway.vote_weight),
  };

  const results = await Promise.all(entries.map(async (e) => {
    const live = e.steam_id
      ? await getPlaytime(e.steam_id, windowStartIso).catch(() => null)
      : null;
    const votes = voteCounts.get(e.user_id) || 0;
    const tickets = computeTickets(
      { manualHours: e.manual_hours, manualSeed: e.manual_seed, steamId: e.steam_id },
      live,
      votes,
      weights
    );
    return {
      userId: e.user_id,
      steamId: e.steam_id,
      manual: e.manual_hours != null,
      hours: e.manual_hours != null ? Number(e.manual_hours) : Number(live?.playtimeHours ?? 0),
      seed:  e.manual_seed  != null ? Number(e.manual_seed)  : Number(live?.seedHours ?? 0),
      votes,
      tickets,
    };
  }));

  results.sort((a, b) => b.tickets - a.tickets);
  return results;
}

export function windowStartIso(windowDays) {
  const d = new Date(Date.now() - windowDays * 86400000);
  return d.toISOString().slice(0, 10);
}
