import config from '../../config.js';
import logger from '../../logger.js';
import { createScheduler } from '../../utils/scheduler.js';
import { getServerStateById } from '../seeding/seedingSocket.js';
import { reportError } from '../admin/errorAlertService.js';
import { evaluateComms } from './commsWatchState.js';
import {
  getOpenProspects, isMember, getDiscordIdBySteamId,
  loadAllStates, upsertState, deleteStatesNotIn,
  getBoardPointer, clearBoardPointer,
} from './commsWatchService.js';
import { buildBoardEmbed, buildProspectAlertEmbed } from './commsWatchEmbeds.js';

const log = logger.child({ module: 'commsWatchMonitor' });

function cfg() {
  const c = config.commsWatch || {};
  return {
    enabled: c.enabled ?? false,
    // Resolve the monitored server by its canonical squadjs_servers.id (the 4th field of
    // SQUADJS_SERVERS), exactly like the seeding announcer — connection NAMES are
    // env-specific labels ("production"/"staging"), the serverId is stable (1 = Main).
    serverId: c.serverId ?? 1,
    serverLabel: c.serverLabel || 'Main', // friendly name for embeds/logs
    tickMs: c.tickMs || 60000,
    boardRefreshMs: c.boardRefreshMs || 120000,
    graceMs: c.blipGraceMs ?? 60000,
    thresholdMs: c.prospectThresholdMs ?? 900000,
    afkChannelId: c.afkChannelId || null,
  };
}

// Board edit throttling state (in-memory; only affects edit cadence, not correctness).
let lastBoardEditAt = 0;
let lastMembershipSig = null;
let lastRenderSig = null;

async function getVoiceSet(client, afkOverride) {
  const guild = await client.guilds.fetch(config.guild.id);
  const afkId = afkOverride || guild.afkChannelId || null;
  const set = new Set();
  for (const vs of guild.voiceStates.cache.values()) {
    if (vs.channelId && vs.channelId !== afkId) set.add(vs.id);
  }
  return set;
}

// Map the live roster to tracked identities. Prospects (by steam_id) take priority over
// members (active Member whitelist). Epic-only / unlinked players are skipped.
async function classifyRoster(players) {
  const openProspects = await getOpenProspects();
  const prospectBySteam = new Map();
  for (const p of openProspects) if (p.steam_id) prospectBySteam.set(String(p.steam_id), p);

  const tracked = [];
  for (const pl of players) {
    const steamId = pl.steamID ? String(pl.steamID) : null;
    if (!steamId) continue; // Epic-only -> unmatchable
    const name = pl.name || null;
    const prospect = prospectBySteam.get(steamId);
    if (prospect) {
      tracked.push({
        discordId: prospect.user_id, steamId, name, kind: 'prospect',
        prospectChannelId: prospect.channel_id, prospectMentorId: prospect.mentor_id, alias: prospect.alias,
      });
      continue;
    }
    if (await isMember(steamId)) {
      const discordId = await getDiscordIdBySteamId(steamId);
      if (!discordId) continue; // unlinked member -> can't voice-check
      tracked.push({ discordId, steamId, name, kind: 'member', prospectChannelId: null, prospectMentorId: null, alias: null });
    }
  }
  return tracked;
}

export async function runMonitorTick(client) {
  const c = cfg();
  if (!c.enabled) return;

  const state = getServerStateById(c.serverId);
  if (!state || !state.connected) return; // never act on stale/absent data

  const players = Array.isArray(state.players) ? state.players : [];
  const now = Date.now();

  const tracked = await classifyRoster(players);
  const voiceSet = await getVoiceSet(client, c.afkChannelId);
  const prevStates = await loadAllStates();

  const violators = [];
  const alerts = [];
  const seen = [];

  for (const t of tracked) {
    seen.push(t.discordId);
    const prev = prevStates.get(t.discordId) || {};
    const obs = { inGame: true, inVoice: voiceSet.has(t.discordId) };
    const next = evaluateComms(prev, obs, now, { graceMs: c.graceMs, thresholdMs: c.thresholdMs });

    await upsertState({
      discordId: t.discordId, steamId: t.steamId, name: t.name, kind: t.kind,
      prospectChannelId: t.prospectChannelId, prospectMentorId: t.prospectMentorId,
      inGameSince: next.inGameSince, observedInVoice: next.observedInVoice,
      voiceChangedAt: next.voiceChangedAt, commsOk: next.commsOk,
      offCommsSince: next.offCommsSince, alerted: next.alerted,
    }).catch((err) => log.warn({ err, discordId: t.discordId }, 'upsertState failed'));

    if (next.isOffComms) violators.push({ discordId: t.discordId, name: t.name, kind: t.kind, offCommsMs: next.offCommsMs });
    if (next.shouldAlert && t.kind === 'prospect') alerts.push({ ...t, offCommsSince: next.offCommsSince, offCommsMs: next.offCommsMs });
  }

  await deleteStatesNotIn(seen);

  for (const a of alerts) {
    await postProspectAlert(client, a, c.serverLabel).catch((err) => log.warn({ err, discordId: a.discordId }, 'postProspectAlert failed'));
  }

  await refreshBoard(client, violators, c, now).catch((err) => log.warn({ err }, 'refreshBoard failed'));
}

async function postProspectAlert(client, a, serverLabel) {
  const channel = await client.channels.fetch(a.prospectChannelId).catch(() => null);
  if (!channel) { log.warn({ discordId: a.discordId, channelId: a.prospectChannelId }, 'prospect channel not found'); return; }
  const mentorRoleId = config.prospects?.mentorRoleId || null;
  let content;
  let allowedMentions;
  if (a.prospectMentorId) { content = `<@${a.prospectMentorId}>`; allowedMentions = { users: [a.prospectMentorId] }; }
  else if (mentorRoleId) { content = `<@&${mentorRoleId}>`; allowedMentions = { roles: [mentorRoleId] }; }
  else { content = undefined; allowedMentions = { parse: [] }; }
  const embed = buildProspectAlertEmbed({ userId: a.discordId, alias: a.alias }, a.offCommsSince, a.offCommsMs, serverLabel);
  await channel.send({ content, embeds: [embed], allowedMentions });
  log.info({ discordId: a.discordId, offCommsMs: a.offCommsMs }, 'Posted prospect comms alert');
}

// Whole-minute buckets so an unchanged board (same people, same displayed minutes) doesn't
// churn edits; membership changes edit immediately, duration ticks refresh on the throttle.
function boardSignature(violators) {
  return violators.map((v) => `${v.discordId}:${Math.floor(v.offCommsMs / 60000)}`).sort().join('|');
}

export async function refreshBoard(client, violators, c, now) {
  const pointer = await getBoardPointer();
  if (!pointer?.channelId || !pointer?.messageId) return;

  const membershipSig = violators.map((v) => v.discordId).sort().join(',');
  const membershipChanged = membershipSig !== lastMembershipSig;
  const throttleElapsed = now - lastBoardEditAt >= c.boardRefreshMs;
  const sig = boardSignature(violators);
  if (!membershipChanged && (!throttleElapsed || sig === lastRenderSig)) return;

  const channel = await client.channels.fetch(pointer.channelId).catch(() => null);
  if (!channel) return;
  const message = await channel.messages.fetch(pointer.messageId).catch(() => null);
  if (!message) { await clearBoardPointer(); lastMembershipSig = null; return; }

  await message.edit({ embeds: [buildBoardEmbed(violators, c.serverLabel, now)] });
  lastBoardEditAt = now;
  lastMembershipSig = membershipSig;
  lastRenderSig = sig;
}

// Render the board from currently-persisted state (used by the command right after a
// fresh tick, before the board pointer exists).
export async function buildCurrentBoardEmbed() {
  const c = cfg();
  const now = Date.now();
  const states = await loadAllStates();
  const violators = [];
  for (const s of states.values()) {
    if (s.commsOk === false && s.offCommsSince != null) {
      violators.push({ discordId: s.discordId, name: s.name, kind: s.kind, offCommsMs: now - s.offCommsSince });
    }
  }
  return buildBoardEmbed(violators, c.serverLabel, now);
}

const scheduler = createScheduler({
  name: 'commsWatch',
  intervalMs: cfg().tickMs,
  tick: async (client) => {
    try {
      await runMonitorTick(client);
    } catch (err) {
      log.error({ err }, 'comms watch tick failed');
      reportError(err, { source: 'scheduler:commsWatch' }).catch(() => {});
    }
  },
});

export function startScheduler(client) {
  const c = cfg();
  if (!c.enabled) { log.info('Comms watch disabled; scheduler not started'); return; }
  log.info({ serverId: c.serverId, serverLabel: c.serverLabel, tickMs: c.tickMs, thresholdMs: c.thresholdMs }, 'Starting comms watch scheduler');
  scheduler.start(client);
}
export function stopScheduler() { scheduler.stop(); }
export function isSchedulerActive() { return scheduler.isActive(); }
