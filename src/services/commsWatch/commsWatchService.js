import { query } from '../../database/connection.js';
import { getDiscordIdBySteamId } from '../userService.js';
import { findEntries } from '../whitelistService.js';
import { getBotState, setBotState } from '../botState.js';
import logger from '../../logger.js';

const log = logger.child({ module: 'commsWatch' });
const BOARD_KEY = 'commsWatchBoard';

// DB TINYINT(1) <-> tri-state boolean (null = undecided). The pure state machine works
// in booleans; the service adapts on read/write.
const toBool = (x) => (x == null ? null : !!x);
const boolToDb = (x) => (x == null ? null : (x ? 1 : 0));
const num = (x) => (x == null ? null : Number(x)); // BIGINT may arrive as BigInt/string

export { getDiscordIdBySteamId };

// Open prospects with a channel (secretary pool — always available even if website is down).
export async function getOpenProspects() {
  try {
    return await query(
      `SELECT id, user_id, steam_id, alias, mentor_id, channel_id
       FROM prospects WHERE status = 'open' AND channel_id IS NOT NULL`,
    );
  } catch (err) {
    log.warn({ err }, 'Failed to load open prospects');
    return [];
  }
}

// Active Member whitelist entry? (website pool; findEntries returns [] if it's unavailable.)
export async function isMember(steamId) {
  try {
    const entries = await findEntries(steamId);
    return entries.some((e) => e.role === 'Member');
  } catch {
    return false;
  }
}

export async function loadAllStates() {
  const map = new Map();
  try {
    const rows = await query('SELECT * FROM comms_watch_state');
    for (const r of rows) {
      map.set(r.discord_id, {
        discordId: r.discord_id,
        steamId: r.steam_id,
        name: r.name,
        kind: r.kind,
        prospectChannelId: r.prospect_channel_id,
        prospectMentorId: r.prospect_mentor_id,
        inGameSince: num(r.in_game_since),
        observedInVoice: toBool(r.observed_in_voice),
        voiceChangedAt: num(r.voice_changed_at),
        commsOk: toBool(r.comms_ok),
        offCommsSince: num(r.off_comms_since),
        alerted: !!r.alerted,
      });
    }
  } catch (err) {
    log.warn({ err }, 'Failed to load comms_watch_state');
  }
  return map;
}

export async function upsertState(s) {
  await query(
    `INSERT INTO comms_watch_state
       (discord_id, steam_id, name, kind, prospect_channel_id, prospect_mentor_id,
        in_game_since, observed_in_voice, voice_changed_at, comms_ok, off_comms_since, alerted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       steam_id=VALUES(steam_id), name=VALUES(name), kind=VALUES(kind),
       prospect_channel_id=VALUES(prospect_channel_id), prospect_mentor_id=VALUES(prospect_mentor_id),
       in_game_since=VALUES(in_game_since), observed_in_voice=VALUES(observed_in_voice),
       voice_changed_at=VALUES(voice_changed_at), comms_ok=VALUES(comms_ok),
       off_comms_since=VALUES(off_comms_since), alerted=VALUES(alerted)`,
    [
      s.discordId, s.steamId ?? null, s.name ?? null, s.kind, s.prospectChannelId ?? null, s.prospectMentorId ?? null,
      s.inGameSince ?? null, boolToDb(s.observedInVoice), s.voiceChangedAt ?? null, boolToDb(s.commsOk),
      s.offCommsSince ?? null, s.alerted ? 1 : 0,
    ],
  );
}

// Prune rows for identities no longer in-game (resets their episode for next session).
export async function deleteStatesNotIn(discordIds) {
  try {
    if (!discordIds.length) { await query('DELETE FROM comms_watch_state'); return; }
    const placeholders = discordIds.map(() => '?').join(',');
    await query(`DELETE FROM comms_watch_state WHERE discord_id NOT IN (${placeholders})`, discordIds);
  } catch (err) {
    log.warn({ err }, 'Failed to prune comms_watch_state');
  }
}

export async function getBoardPointer() { return getBotState(BOARD_KEY); }
export async function setBoardPointer(channelId, messageId) { return setBotState(BOARD_KEY, { channelId, messageId }); }
export async function clearBoardPointer() { return setBotState(BOARD_KEY, null); }
