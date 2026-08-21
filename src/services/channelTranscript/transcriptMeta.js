export function isThreadChannel(channel) {
  if (!channel) return false;
  if (typeof channel.isThread === 'function') return Boolean(channel.isThread());
  return false;
}

export function getStaffChannelId(channel) {
  if (!channel) return null;
  if (isThreadChannel(channel)) return channel.parentId || null;
  return channel.id || null;
}

export function getThreadMeta(channel) {
  if (!isThreadChannel(channel)) return { threadId: null, threadName: null };
  return {
    threadId: channel.id || null,
    threadName: channel.name || null,
  };
}

export function getReplyToId(message) {
  return message?.reference?.messageId || null;
}

export function serializeEmbeds(message) {
  const embeds = message?.embeds;
  if (!embeds || embeds.length === 0) return null;
  return embeds.map((embed) => (typeof embed.toJSON === 'function' ? embed.toJSON() : embed));
}

export function isRelayMirrorId(messageId, channelMessageIds) {
  if (!messageId || !channelMessageIds) return false;
  return channelMessageIds.has(messageId);
}
