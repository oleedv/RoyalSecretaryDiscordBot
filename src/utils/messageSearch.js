/**
 * Find a bot message in a channel that contains a component with a given customId.
 */
export async function findBotMessageByCustomId(channel, botUserId, customIds) {
  const ids = Array.isArray(customIds) ? customIds : [customIds];
  const messages = await channel.messages.fetch({ limit: 20 });
  return messages.find(
    (m) =>
      m.author.id === botUserId &&
      m.components.some((row) =>
        row.components.some((c) => ids.includes(c.customId))
      )
  ) || null;
}
