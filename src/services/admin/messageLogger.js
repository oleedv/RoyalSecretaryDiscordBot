import { query } from '../../database/connection.js';
import { getReplyToId, getThreadMeta, isThreadChannel } from '../channelTranscript/transcriptMeta.js';

const REPLY_SNIPPET_MAX = 180;

function snippet(text) {
  if (!text) return null;
  const trimmed = String(text).replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  if (trimmed.length <= REPLY_SNIPPET_MAX) return trimmed;
  return trimmed.slice(0, REPLY_SNIPPET_MAX);
}

export function buildMessageLogFields(message) {
  const isDm = !message.guild;
  const channel = message.channel || {};
  const inThread = isThreadChannel(channel);
  const { threadId, threadName } = getThreadMeta(channel);
  const referenced = message.referencedMessage || null;
  const repliedUser = message.mentions?.repliedUser || null;

  const parentChannelId = inThread
    ? (channel.parentId || null)
    : (isDm ? null : (channel.id || null));
  const parentChannelName = inThread
    ? (channel.parent?.name || null)
    : (isDm ? 'DM' : (channel.name || null));

  return {
    messageId: message.id,
    channelId: channel.id,
    channelName: isDm ? 'DM' : (channel.name || null),
    parentChannelId,
    parentChannelName,
    threadId,
    threadName,
    replyToMessageId: getReplyToId(message),
    replyToTag: referenced?.author?.tag || repliedUser?.tag || null,
    replyToContent: snippet(referenced?.content),
    guildId: message.guild?.id || null,
    authorId: message.author.id,
    authorTag: message.author.tag,
    content: message.content || null,
    attachments: message.attachments?.size > 0
      ? JSON.stringify(message.attachments.map((a) => ({ url: a.url, name: a.name, size: a.size })))
      : null,
    isDm,
  };
}

export function isLoggableHumanMessage(message) {
  if (!message?.author?.id) return false;
  if (message.author.bot) return false;
  if (message.webhookId) return false;
  if (message.system) return false;
  return true;
}

export function logMessage(message) {
  if (!isLoggableHumanMessage(message)) return;

  const row = buildMessageLogFields(message);

  query(
    `INSERT INTO bot_messages (
       message_id, channel_id, channel_name, guild_id, author_id, author_tag,
       content, attachments, is_dm, direction,
       parent_channel_id, parent_channel_name, thread_id, thread_name,
       reply_to_message_id, reply_to_tag, reply_to_content
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'incoming', ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.messageId,
      row.channelId,
      row.channelName,
      row.guildId,
      row.authorId,
      row.authorTag,
      row.content,
      row.attachments,
      row.isDm ? 1 : 0,
      row.parentChannelId,
      row.parentChannelName,
      row.threadId,
      row.threadName,
      row.replyToMessageId,
      row.replyToTag,
      row.replyToContent,
    ]
  ).catch(() => {});
}
