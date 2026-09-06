import { query } from '../../database/connection.js';

// 60-day moderation log. This process only writes; the ops retention job
// deletes bot_messages older than MESSAGE_LOG_RETENTION_DAYS.
export const MESSAGE_LOG_RETENTION_DAYS = 60;

export function logMessage(message) {
  const isDm = !message.guild;
  const attachments = message.attachments.size > 0
    ? JSON.stringify(message.attachments.map(a => ({ url: a.url, name: a.name, size: a.size })))
    : null;

  query(
    `INSERT INTO bot_messages (message_id, channel_id, channel_name, guild_id, author_id, author_tag, content, attachments, is_dm, direction)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'incoming')`,
    [
      message.id,
      message.channel.id,
      isDm ? 'DM' : (message.channel.name || null),
      message.guild?.id || null,
      message.author.id,
      message.author.tag,
      message.content || null,
      attachments,
      isDm ? 1 : 0,
    ]
  ).catch(() => {});
}
