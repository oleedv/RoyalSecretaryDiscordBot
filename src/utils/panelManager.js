import logger from '../logger.js';

const log = logger.child({ module: 'panelManager' });

/**
 * Generic panel manager — ensures exactly one panel message exists in a channel.
 *
 * @param {Client}   client       Discord client
 * @param {string}   channelId    Channel to check/post in
 * @param {string}   customId     Button customId that identifies the panel
 * @param {Function} buildMessage Function that returns the panel message payload ({ embeds, components })
 * @param {string}   label        Human-readable label for logging
 */
export async function ensurePanel(client, channelId, customId, buildMessage, label) {
  if (!channelId) {
    log.warn(`No ${label} panelChannelId configured — skipping panel check`);
    return;
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    log.warn(`${label} panel channel ${channelId} not found — skipping panel check`);
    return;
  }

  const messages = await channel.messages.fetch({ limit: 50 });
  const hasPanel = messages.some(
    (msg) =>
      msg.author.id === client.user.id &&
      msg.components.some((row) =>
        row.components.some((c) => c.customId === customId)
      )
  );

  if (hasPanel) {
    log.info(`${label} panel already exists`);
    return;
  }

  await channel.send(buildMessage());
  log.info(`${label} panel posted automatically`);
}
