import {
  createGiveaway,
  getActiveGiveaway,
  getGiveawayConfig,
  setEntryMessage,
  setVoteMessage,
  upsertManualEntry,
  computeLeaderboard,
  windowStartIso,
  listEntries,
  markDrawn,
  cancelGiveaway,
} from './giveawayService.js';
import { rulesFromConfig } from './giveawayRules.js';
import { buildEntryEmbed, buildEntryRow, buildVoteMessages, buildWinnerEmbed } from './giveawayEmbeds.js';
import { refreshEntryMessage } from './giveawayMessage.js';
import { pickWinner } from './giveawayDraw.js';
import logger from '../../logger.js';

const log = logger.child({ module: 'giveawayActions' });

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

export function lastDayOfThisMonthIso() {
  const now = new Date();
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59));
  return last;
}

export function currentMonthLabel() {
  const now = new Date();
  return `${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
}

export class GiveawayActionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GiveawayActionError';
  }
}

async function requireActive(expectedStatuses) {
  const giveaway = await getActiveGiveaway();
  if (!giveaway) throw new GiveawayActionError('No active giveaway.');
  if (expectedStatuses && !expectedStatuses.includes(giveaway.status)) {
    throw new GiveawayActionError(`Giveaway is in status '${giveaway.status}'.`);
  }
  return giveaway;
}

async function resolveChannel(client, channelOrId) {
  if (channelOrId && typeof channelOrId === 'object' && typeof channelOrId.send === 'function') {
    return channelOrId;
  }
  const id = typeof channelOrId === 'string' ? channelOrId : channelOrId?.id;
  if (!id) return null;
  return await client.channels.fetch(id).catch(() => null);
}

/**
 * Create a giveaway row and post the public entry message.
 * `channel` may be a Discord channel object or a snowflake.
 */
export async function startGiveaway({ client, prize, channel, createdBy, monthLabel, drawAt, rules }) {
  const existing = await getActiveGiveaway();
  if (existing) {
    throw new GiveawayActionError(
      `A giveaway is already active (id ${existing.id}, status ${existing.status}). Cancel or draw it first.`
    );
  }

  const resolved = await resolveChannel(client, channel);
  if (!resolved || typeof resolved.send !== 'function') {
    throw new GiveawayActionError('Could not resolve entry channel.');
  }

  const cfg = await getGiveawayConfig();
  const resolvedRules = rulesFromConfig(cfg, rules || {});
  const giveaway = await createGiveaway({
    prize,
    monthLabel: monthLabel || currentMonthLabel(),
    drawAt: drawAt ? new Date(drawAt) : lastDayOfThisMonthIso(),
    entryChannelId: resolved.id,
    createdBy,
    ...resolvedRules,
  });

  const message = await resolved.send({
    embeds: [buildEntryEmbed(giveaway, 0)],
    components: [buildEntryRow(giveaway.id)],
  });

  await setEntryMessage(giveaway.id, resolved.id, message.id);
  log.info({ giveawayId: giveaway.id, prize, channelId: resolved.id }, 'Giveaway started');
  return { giveaway, channel: resolved };
}

export async function addManualGiveawayEntry({ client, userId, hours, seed, addedBy }) {
  const giveaway = await requireActive(['open', 'voting']);
  await upsertManualEntry(giveaway.id, userId, hours, seed, addedBy);
  await refreshEntryMessage(client, giveaway);
  log.info({ giveawayId: giveaway.id, userId, hours, seed, addedBy }, 'Manual entry added');
  return { giveaway };
}

export async function openGiveawayVote({ client, guild, channel }) {
  const giveaway = await requireActive(['open']);
  const entries = await listEntries(giveaway.id);
  if (entries.length === 0) {
    throw new GiveawayActionError('No one has entered yet.');
  }

  const resolved = await resolveChannel(client, channel)
    || (guild ? await guild.channels.fetch(giveaway.entry_channel_id).catch(() => null) : null)
    || await client.channels.fetch(giveaway.entry_channel_id).catch(() => null);
  if (!resolved || typeof resolved.send !== 'function') {
    throw new GiveawayActionError('Could not resolve vote channel.');
  }

  const resolvedGuild = guild || resolved.guild;
  const enriched = await Promise.all(entries.map(async (e) => {
    const member = resolvedGuild
      ? await resolvedGuild.members.fetch(e.user_id).catch(() => null)
      : null;
    return { userId: e.user_id, displayName: member?.displayName || e.user_id };
  }));

  const pages = buildVoteMessages(giveaway, enriched);
  let firstMessage = null;
  for (const payload of pages) {
    const sent = await resolved.send(payload);
    if (!firstMessage) firstMessage = sent;
  }

  await setVoteMessage(giveaway.id, resolved.id, firstMessage.id);
  log.info({ giveawayId: giveaway.id, pages: pages.length, channelId: resolved.id }, 'Vote post opened');
  return { giveaway, channel: resolved, pages: pages.length };
}

export async function drawGiveaway({ client, fallbackChannel }) {
  const giveaway = await getActiveGiveaway();
  if (!giveaway) throw new GiveawayActionError('No active giveaway.');
  if (giveaway.status === 'drawn') {
    throw new GiveawayActionError(`Already drawn; winner: <@${giveaway.winner_user_id}>.`);
  }
  if (giveaway.status === 'cancelled') {
    throw new GiveawayActionError('Giveaway is cancelled.');
  }

  const leaderboard = await computeLeaderboard(giveaway, windowStartIso(giveaway.window_days));
  const winnerRow = pickWinner(leaderboard);
  if (!winnerRow) {
    throw new GiveawayActionError('No eligible entries (total tickets is 0).');
  }

  await markDrawn(giveaway.id, winnerRow.userId);

  const channel = await client.channels.fetch(giveaway.entry_channel_id).catch(() => null);
  const target = (channel && typeof channel.send === 'function') ? channel : fallbackChannel;
  if (!target || typeof target.send !== 'function') {
    throw new GiveawayActionError('Could not resolve a channel to post the winner.');
  }
  await target.send({ embeds: [buildWinnerEmbed(giveaway, winnerRow, leaderboard)] });

  log.info({ giveawayId: giveaway.id, winnerId: winnerRow.userId, tickets: winnerRow.tickets }, 'Giveaway drawn');
  return { giveaway, winner: winnerRow, channel: target };
}

export async function cancelActiveGiveaway({ client }) {
  const giveaway = await requireActive();
  await cancelGiveaway(giveaway.id);

  for (const [chId, mId] of [
    [giveaway.entry_channel_id, giveaway.entry_message_id],
    [giveaway.vote_channel_id, giveaway.vote_message_id],
  ]) {
    if (!chId || !mId) continue;
    const ch = await client.channels.fetch(chId).catch(() => null);
    if (!ch) continue;
    const msg = await ch.messages.fetch(mId).catch(() => null);
    if (msg) await msg.delete().catch((err) => log.warn({ err, mId }, 'Failed to delete giveaway message'));
  }

  log.info({ giveawayId: giveaway.id }, 'Giveaway cancelled');
  return { giveaway };
}

export async function refreshActiveEntryMessage({ client }) {
  const giveaway = await getActiveGiveaway();
  if (!giveaway) return;
  await refreshEntryMessage(client, giveaway);
}
