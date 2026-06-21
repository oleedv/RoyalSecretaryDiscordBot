import logger from '../../logger.js';
import { SL_HYPERCARE_CHANNEL_ID, SL_HYPERCARE_VERBOSE } from './constants.js';

const log = logger.child({ module: 'sl-reward-hypercare' });

/**
 * Post a standard SL-reward embed (built via ./embeds.js) to the hypercare channel.
 * Per-action detail passes verboseOnly:true so it can be silenced by flipping
 * slReward.hypercareVerbose to false without a code change. An optional `files` array
 * (discord.js AttachmentBuilder[]) is uploaded alongside the embed.
 */
export async function hypercareSend(client, embed, { verboseOnly = false, files } = {}) {
  if (!SL_HYPERCARE_CHANNEL_ID || !embed) return;
  if (verboseOnly && !SL_HYPERCARE_VERBOSE) return;
  try {
    const channel = await client.channels.fetch(SL_HYPERCARE_CHANNEL_ID).catch(() => null);
    if (!channel) return;
    const payload = { embeds: [embed], ...(files?.length ? { files } : {}) };
    await channel.send(payload).catch((e) => log.warn({ err: e?.message }, 'send failed'));
  } catch (err) {
    log.warn({ err }, 'hypercareSend failed');
  }
}
