import { query } from '../../database/connection.js';
import { formatForDb } from '../../utils/attachments.js';
import config from '../../config.js';
import logger from '../../logger.js';
import {
  getStaffChannelId,
  getThreadMeta,
  getReplyToId,
  serializeEmbeds,
  isForeignBotMessage,
} from './transcriptMeta.js';

const log = logger.child({ module: 'channelTranscript' });

const TABLE = { ticket: 'ticket_messages', prospect: 'prospect_messages' };
const FK = { ticket: 'ticket_id', prospect: 'prospect_id' };

export async function resolveStaffTarget(channel) {
  const channelId = getStaffChannelId(channel);
  if (!channelId) return null;

  const tickets = await query(
    'SELECT * FROM tickets WHERE channel_id = ? ORDER BY created_at DESC LIMIT 1',
    [channelId]
  );
  if (tickets[0]) return { kind: 'ticket', record: tickets[0] };

  const prospects = await query(
    'SELECT * FROM prospects WHERE channel_id = ? ORDER BY created_at DESC LIMIT 1',
    [channelId]
  );
  if (prospects[0]) return { kind: 'prospect', record: prospects[0] };

  return null;
}

function rowFromDiscordMessage(message) {
  const { threadId, threadName } = getThreadMeta(message.channel);
  const author = message.author;
  const isBot = Boolean(author?.bot);
  return {
    authorId: author?.id || '0',
    authorTag: author?.tag || 'Unknown',
    content: message.content || null,
    attachments: formatForDb(Array.from(message.attachments?.values?.() || [])),
    isStaff: !isBot,
    isBot,
    sourceMessageId: null,
    channelMessageId: threadId ? null : message.id,
    discordMessageId: message.id,
    replyToMessageId: getReplyToId(message),
    threadId,
    threadName,
    embeds: serializeEmbeds(message),
    createdAt: message.createdAt || new Date(),
  };
}

function applyOwnerStaff(row, ownerUserId) {
  if (row.isBot) {
    row.isStaff = false;
    return row;
  }
  row.isStaff = !ownerUserId || row.authorId !== ownerUserId;
  return row;
}

export async function insertTranscriptRow(kind, recordId, row, { overwrite = false } = {}) {
  const table = TABLE[kind];
  const fk = FK[kind];
  if (!table || !recordId) return false;

  const values = [
    recordId,
    row.authorId,
    row.authorTag,
    row.content,
    JSON.stringify(row.attachments || []),
    row.isStaff ? 1 : 0,
    row.sourceMessageId || null,
    row.channelMessageId || null,
    row.discordMessageId || null,
    row.replyToMessageId || null,
    row.threadId || null,
    row.threadName || null,
    row.isBot ? 1 : 0,
    row.embeds ? JSON.stringify(row.embeds) : null,
    row.createdAt || new Date(),
  ];

  const sql = overwrite
    ? `INSERT INTO ${table} (
         ${fk}, author_id, author_tag, content, attachments, is_staff,
         source_message_id, channel_message_id, discord_message_id,
         reply_to_message_id, thread_id, thread_name, is_bot, embeds, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         author_id = VALUES(author_id),
         author_tag = VALUES(author_tag),
         content = VALUES(content),
         attachments = VALUES(attachments),
         is_staff = VALUES(is_staff),
         source_message_id = COALESCE(VALUES(source_message_id), source_message_id),
         channel_message_id = COALESCE(VALUES(channel_message_id), channel_message_id),
         reply_to_message_id = COALESCE(VALUES(reply_to_message_id), reply_to_message_id),
         thread_id = COALESCE(VALUES(thread_id), thread_id),
         thread_name = COALESCE(VALUES(thread_name), thread_name),
         is_bot = VALUES(is_bot),
         embeds = COALESCE(VALUES(embeds), embeds)`
    : `INSERT IGNORE INTO ${table} (
         ${fk}, author_id, author_tag, content, attachments, is_staff,
         source_message_id, channel_message_id, discord_message_id,
         reply_to_message_id, thread_id, thread_name, is_bot, embeds, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  const result = await query(sql, values);
  return result.affectedRows > 0;
}

export async function captureStaffMessage(message, target = null) {
  const resolved = target || await resolveStaffTarget(message.channel);
  if (!resolved) return false;
  if (!message?.id || !message.author) return false;
  if (isForeignBotMessage(message, message.client?.user?.id)) return false;

  const row = applyOwnerStaff(rowFromDiscordMessage(message), resolved.record.user_id);
  await insertTranscriptRow(resolved.kind, resolved.record.id, row, { overwrite: false });
  return true;
}

async function backfillTextChannel(target, channel) {
  let before;
  let inserted = 0;
  let scanned = 0;

  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || batch.size === 0) break;

    const selfBotId = channel.client?.user?.id || null;
    for (const message of batch.values()) {
      scanned++;
      if (isForeignBotMessage(message, selfBotId)) continue;
      const row = applyOwnerStaff(rowFromDiscordMessage(message), target.record.user_id);
      const wrote = await insertTranscriptRow(target.kind, target.record.id, row, { overwrite: false });
      if (wrote) inserted++;
    }

    before = batch.last()?.id;
    if (batch.size < 100 || !before) break;
  }

  return { inserted, scanned };
}

async function fetchAllThreads(channel) {
  const threads = [];
  if (!channel?.threads?.fetchActive) return threads;

  const active = await channel.threads.fetchActive().catch(() => null);
  if (active?.threads) threads.push(...active.threads.values());

  for (const type of ['public', 'private']) {
    const archived = await channel.threads.fetchArchived({ type, fetchAll: true }).catch(() => null);
    if (archived?.threads) threads.push(...archived.threads.values());
  }

  const seen = new Set();
  return threads.filter((thread) => {
    if (!thread?.id || seen.has(thread.id)) return false;
    seen.add(thread.id);
    return true;
  });
}

export async function flushStaffChannel(channel, target = null) {
  const resolved = target || await resolveStaffTarget(channel);
  if (!resolved || !channel) return { inserted: 0, scanned: 0 };

  let inserted = 0;
  let scanned = 0;

  const parent = await backfillTextChannel(resolved, channel);
  inserted += parent.inserted;
  scanned += parent.scanned;

  const threads = await fetchAllThreads(channel);
  for (const thread of threads) {
    const result = await backfillTextChannel(resolved, thread);
    inserted += result.inserted;
    scanned += result.scanned;
  }

  return { inserted, scanned };
}

export async function flushThenDelete(channel, reason) {
  if (!channel) return;
  try {
    const result = await flushStaffChannel(channel);
    log.info({ channelId: channel.id, ...result }, 'Flushed staff channel before delete');
  } catch (err) {
    log.warn({ err, channelId: channel.id }, 'Staff channel flush failed; proceeding with delete');
  }
  await channel.delete(reason).catch(() => null);
}

export async function backfillOpenStaffChannels(client) {
  const guild = await client.guilds.fetch(config.guild.id).catch(() => null);
  if (!guild) return { tickets: 0, prospects: 0 };

  const tickets = await query(
    "SELECT * FROM tickets WHERE channel_id IS NOT NULL AND status IN ('open', 'closing')"
  );
  const prospects = await query(
    "SELECT * FROM prospects WHERE channel_id IS NOT NULL AND status IN ('open', 'accepted', 'denied', 'closed')"
  );

  let ticketCount = 0;
  for (const row of tickets) {
    const channel = await guild.channels.fetch(row.channel_id).catch(() => null);
    if (!channel) continue;
    const result = await flushStaffChannel(channel, { kind: 'ticket', record: row });
    ticketCount += result.inserted;
    if (result.inserted > 0) {
      log.info({ ticketId: row.id, ...result }, 'Backfilled ticket channel transcript');
    }
  }

  let prospectCount = 0;
  for (const row of prospects) {
    const channel = await guild.channels.fetch(row.channel_id).catch(() => null);
    if (!channel) continue;
    const result = await flushStaffChannel(channel, { kind: 'prospect', record: row });
    prospectCount += result.inserted;
    if (result.inserted > 0) {
      log.info({ prospectId: row.id, ...result }, 'Backfilled prospect channel transcript');
    }
  }

  log.info({ ticketInserted: ticketCount, prospectInserted: prospectCount }, 'Staff transcript backfill finished');
  return { tickets: ticketCount, prospects: prospectCount };
}
