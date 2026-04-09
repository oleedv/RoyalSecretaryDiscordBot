import { ChannelType } from 'discord.js';
import { query } from '../../database/connection.js';
import logger from '../../logger.js';

const log = logger.child({ module: 'voiceTracker' });

/** @type {Map<string, SessionState>} userId -> active voice session */
const activeSessions = new Map();

function isMuted(state) {
  return state.selfMute || state.serverMute;
}

function isDeafened(state) {
  return state.selfDeaf || state.serverDeaf;
}

function createSession(voiceState) {
  const now = new Date();
  const muted = isMuted(voiceState);
  const deafened = isDeafened(voiceState);

  return {
    channelId: voiceState.channelId,
    channelName: voiceState.channel?.name || null,
    joinedAt: now,
    selfMute: voiceState.selfMute,
    selfDeaf: voiceState.selfDeaf,
    serverMute: voiceState.serverMute,
    serverDeaf: voiceState.serverDeaf,
    streaming: voiceState.streaming,
    selfVideo: voiceState.selfVideo,
    // Track muted only when NOT deafened to avoid overlap (deafened implies muted)
    mutedSince: (muted && !deafened) ? now : null,
    deafenedSince: deafened ? now : null,
    streamingSince: voiceState.streaming ? now : null,
    videoSince: voiceState.selfVideo ? now : null,
    accMutedMs: 0,
    accDeafenedMs: 0,
    accStreamingMs: 0,
    accVideoMs: 0,
    dbRowId: null,
    lastFlushAt: now,
  };
}

function closeAccumulators(session) {
  const now = new Date();
  if (session.mutedSince) {
    session.accMutedMs += now - session.mutedSince;
    session.mutedSince = null;
  }
  if (session.deafenedSince) {
    session.accDeafenedMs += now - session.deafenedSince;
    session.deafenedSince = null;
  }
  if (session.streamingSince) {
    session.accStreamingMs += now - session.streamingSince;
    session.streamingSince = null;
  }
  if (session.videoSince) {
    session.accVideoMs += now - session.videoSince;
    session.videoSince = null;
  }
  return now;
}

function msToSeconds(ms) {
  return Math.round(ms / 1000);
}

async function writeSessionToDb(userId, session, leftAt) {
  const durationSeconds = Math.round((leftAt - session.joinedAt) / 1000);
  const mutedSeconds = msToSeconds(session.accMutedMs);
  const deafenedSeconds = msToSeconds(session.accDeafenedMs);
  const streamingSeconds = msToSeconds(session.accStreamingMs);
  const videoSeconds = msToSeconds(session.accVideoMs);

  try {
    if (session.dbRowId) {
      await query(
        `UPDATE voice_sessions
         SET left_at = ?, duration_seconds = ?, muted_seconds = ?, deafened_seconds = ?, streaming_seconds = ?, video_seconds = ?
         WHERE id = ?`,
        [leftAt, durationSeconds, mutedSeconds, deafenedSeconds, streamingSeconds, videoSeconds, session.dbRowId]
      );
    } else {
      await query(
        `INSERT INTO voice_sessions (user_id, channel_id, channel_name, joined_at, left_at, duration_seconds, muted_seconds, deafened_seconds, streaming_seconds, video_seconds)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, session.channelId, session.channelName, session.joinedAt, leftAt, durationSeconds, mutedSeconds, deafenedSeconds, streamingSeconds, videoSeconds]
      );
    }
  } catch (err) {
    log.error({ err, userId }, 'Failed to write voice session to DB');
  }
}

export function handleVoiceStateUpdate(oldState, newState) {
  if (newState.member?.user?.bot) return;
  const userId = newState.id;
  const oldChannel = oldState.channelId;
  const newChannel = newState.channelId;

  // Join
  if (!oldChannel && newChannel) {
    const session = createSession(newState);
    activeSessions.set(userId, session);
    log.debug({ userId, channelId: newChannel }, 'Voice session started');
    return;
  }

  // Leave
  if (oldChannel && !newChannel) {
    const session = activeSessions.get(userId);
    if (!session) return;
    const leftAt = closeAccumulators(session);
    writeSessionToDb(userId, session, leftAt);
    activeSessions.delete(userId);
    log.debug({ userId, channelId: oldChannel }, 'Voice session ended');
    return;
  }

  // Channel switch
  if (oldChannel && newChannel && oldChannel !== newChannel) {
    const session = activeSessions.get(userId);
    if (session) {
      const leftAt = closeAccumulators(session);
      writeSessionToDb(userId, session, leftAt);
    }
    const newSession = createSession(newState);
    activeSessions.set(userId, newSession);
    log.debug({ userId, from: oldChannel, to: newChannel }, 'Voice channel switched');
    return;
  }

  // State toggle (same channel)
  if (oldChannel && newChannel && oldChannel === newChannel) {
    const session = activeSessions.get(userId);
    if (!session) return;

    const now = new Date();

    // Deafen toggle (check first since it affects mute tracking)
    const wasDeafened = isDeafened(oldState);
    const nowDeafened = isDeafened(newState);
    if (wasDeafened && !nowDeafened) {
      // Stopped being deafened
      if (session.deafenedSince) {
        session.accDeafenedMs += now - session.deafenedSince;
        session.deafenedSince = null;
      }
      // If still muted after undeafen, start tracking muted
      if (isMuted(newState)) {
        session.mutedSince = now;
      }
    } else if (!wasDeafened && nowDeafened) {
      // Became deafened - close any open mute period (deafened supersedes muted)
      if (session.mutedSince) {
        session.accMutedMs += now - session.mutedSince;
        session.mutedSince = null;
      }
      session.deafenedSince = now;
    }

    // Mute toggle (only when not deafened, since deafened supersedes muted)
    if (!nowDeafened) {
      const wasMuted = isMuted(oldState);
      const nowMuted = isMuted(newState);
      if (wasMuted && !nowMuted && session.mutedSince) {
        session.accMutedMs += now - session.mutedSince;
        session.mutedSince = null;
      } else if (!wasMuted && nowMuted && !session.mutedSince) {
        session.mutedSince = now;
      }
    }

    // Streaming toggle
    if (oldState.streaming && !newState.streaming && session.streamingSince) {
      session.accStreamingMs += now - session.streamingSince;
      session.streamingSince = null;
    } else if (!oldState.streaming && newState.streaming) {
      session.streamingSince = now;
    }

    // Video toggle
    if (oldState.selfVideo && !newState.selfVideo && session.videoSince) {
      session.accVideoMs += now - session.videoSince;
      session.videoSince = null;
    } else if (!oldState.selfVideo && newState.selfVideo) {
      session.videoSince = now;
    }

    // Update stored state
    session.selfMute = newState.selfMute;
    session.selfDeaf = newState.selfDeaf;
    session.serverMute = newState.serverMute;
    session.serverDeaf = newState.serverDeaf;
    session.streaming = newState.streaming;
    session.selfVideo = newState.selfVideo;
  }
}

export async function finalizeSession(userId) {
  const session = activeSessions.get(userId);
  if (!session) return;
  const leftAt = closeAccumulators(session);
  await writeSessionToDb(userId, session, leftAt);
  activeSessions.delete(userId);
}

export async function finalizeAllSessions() {
  const promises = [];
  for (const [userId, session] of activeSessions) {
    const leftAt = closeAccumulators(session);
    promises.push(writeSessionToDb(userId, session, leftAt));
  }
  await Promise.allSettled(promises);
  activeSessions.clear();
  log.info(`Finalized ${promises.length} active voice session(s)`);
}

export async function recoverActiveSessions(client) {
  // Close orphaned rows from previous run
  try {
    const result = await query(
      `UPDATE voice_sessions
       SET left_at = NOW(),
           duration_seconds = TIMESTAMPDIFF(SECOND, joined_at, NOW())
       WHERE left_at IS NULL`
    );
    if (result.affectedRows > 0) {
      log.info(`Closed ${result.affectedRows} orphaned voice session(s)`);
    }
  } catch (err) {
    log.error({ err }, 'Failed to close orphaned voice sessions');
  }

  // Scan voice states for currently connected members
  try {
    const { default: config } = await import('../../config.js');
    const guild = await client.guilds.fetch(config.guild.id);

    // Only fetch members currently in voice channels instead of the entire guild
    const voiceUserIds = [...guild.voiceStates.cache.values()]
      .filter(vs => vs.channelId)
      .map(vs => vs.id);

    if (voiceUserIds.length > 0) {
      await guild.members.fetch({ user: voiceUserIds });
    }

    let recovered = 0;
    for (const [, channel] of guild.channels.cache) {
      if (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice) continue;
      for (const [memberId, member] of channel.members) {
        if (member.user.bot) continue;
        const session = createSession(member.voice);
        activeSessions.set(memberId, session);
        recovered++;
      }
    }

    if (recovered > 0) {
      log.info(`Recovered ${recovered} active voice session(s)`);
    }
  } catch (err) {
    log.error({ err }, 'Failed to recover active voice sessions');
  }
}

export async function flushActiveSessions() {
  if (activeSessions.size === 0) return;

  let flushed = 0;
  for (const [userId, session] of activeSessions) {
    const now = new Date();
    const durationSeconds = Math.round((now - session.joinedAt) / 1000);

    // Compute current accumulated values (without closing open periods)
    let mutedMs = session.accMutedMs;
    let deafenedMs = session.accDeafenedMs;
    let streamingMs = session.accStreamingMs;
    let videoMs = session.accVideoMs;
    if (session.mutedSince) mutedMs += now - session.mutedSince;
    if (session.deafenedSince) deafenedMs += now - session.deafenedSince;
    if (session.streamingSince) streamingMs += now - session.streamingSince;
    if (session.videoSince) videoMs += now - session.videoSince;

    try {
      if (session.dbRowId) {
        await query(
          `UPDATE voice_sessions
           SET duration_seconds = ?, muted_seconds = ?, deafened_seconds = ?, streaming_seconds = ?, video_seconds = ?
           WHERE id = ?`,
          [durationSeconds, msToSeconds(mutedMs), msToSeconds(deafenedMs), msToSeconds(streamingMs), msToSeconds(videoMs), session.dbRowId]
        );
      } else {
        const result = await query(
          `INSERT INTO voice_sessions (user_id, channel_id, channel_name, joined_at, left_at, duration_seconds, muted_seconds, deafened_seconds, streaming_seconds, video_seconds)
           VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
          [userId, session.channelId, session.channelName, session.joinedAt, durationSeconds, msToSeconds(mutedMs), msToSeconds(deafenedMs), msToSeconds(streamingMs), msToSeconds(videoMs)]
        );
        session.dbRowId = Number(result.insertId);
      }
      session.lastFlushAt = now;
      flushed++;
    } catch (err) {
      log.error({ err, userId }, 'Failed to flush voice session');
    }
  }

  if (flushed > 0) {
    log.debug(`Flushed ${flushed} active voice session(s)`);
  }
}

export function getActiveSession(userId) {
  const session = activeSessions.get(userId);
  if (!session) return null;

  const now = new Date();
  let mutedMs = session.accMutedMs;
  let deafenedMs = session.accDeafenedMs;
  let streamingMs = session.accStreamingMs;
  let videoMs = session.accVideoMs;
  if (session.mutedSince) mutedMs += now - session.mutedSince;
  if (session.deafenedSince) deafenedMs += now - session.deafenedSince;
  if (session.streamingSince) streamingMs += now - session.streamingSince;
  if (session.videoSince) videoMs += now - session.videoSince;

  return {
    channelId: session.channelId,
    channelName: session.channelName,
    joinedAt: session.joinedAt,
    durationSeconds: Math.round((now - session.joinedAt) / 1000),
    mutedSeconds: msToSeconds(mutedMs),
    deafenedSeconds: msToSeconds(deafenedMs),
    streamingSeconds: msToSeconds(streamingMs),
    videoSeconds: msToSeconds(videoMs),
  };
}
