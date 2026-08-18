export const QUICK_STATUS_FOOTER = 'Royal Secretary · refreshes every 60s';
export const MISSING_DISCORD_TITLE = 'Not on Discord while playing';

function embedTitle(embed) {
  return embed?.title || '';
}

function embedFooter(embed) {
  return embed?.footer?.text || '';
}

export function isQuickStatusMessage(msg, botId) {
  if (!msg || msg.author?.id !== botId) return false;
  const embeds = msg.embeds || [];
  return embeds.some((embed) => {
    const footer = embedFooter(embed);
    const title = embedTitle(embed);
    return footer.includes(QUICK_STATUS_FOOTER) || title === MISSING_DISCORD_TITLE;
  });
}

export function collectQuickStatusMessages(messages, botId) {
  return [...(messages || [])].filter((msg) => isQuickStatusMessage(msg, botId));
}

export function selectQuickStatusMessage(messages, botId) {
  const hits = collectQuickStatusMessages(messages, botId)
    .sort((a, b) => (a.createdTimestamp || 0) - (b.createdTimestamp || 0));
  return hits[0] || null;
}

/**
 * Post a replacement first, then delete the previous messages.
 * If send fails, the old messages stay put.
 */
export async function postThenDeleteQuickStatus({ channel, embeds, oldMessages = [] }) {
  const sent = await channel.send({ embeds });
  for (const msg of oldMessages) {
    if (msg?.id && msg.id !== sent.id) {
      await msg.delete().catch(() => {});
    }
  }
  return sent;
}
