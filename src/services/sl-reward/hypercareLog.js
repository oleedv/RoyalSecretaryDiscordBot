import logger from '../../logger.js';
import { SL_HYPERCARE_CHANNEL_ID, SL_HYPERCARE_VERBOSE } from './constants.js';

const log = logger.child({ module: 'sl-reward-hypercare' });

/**
 * Post a standard SL-reward embed (built via ./embeds.js) to the hypercare channel.
 * Run summaries post always; per-action detail passes verboseOnly:true so it can be
 * silenced later by flipping slReward.hypercareVerbose to false without a code change.
 */
export async function hypercareSend(client, embed, { verboseOnly = false } = {}) {
  if (!SL_HYPERCARE_CHANNEL_ID || !embed) return;
  if (verboseOnly && !SL_HYPERCARE_VERBOSE) return;
  try {
    const channel = await client.channels.fetch(SL_HYPERCARE_CHANNEL_ID).catch(() => null);
    if (!channel) return;
    await channel.send({ embeds: [embed] }).catch((e) => log.warn({ err: e?.message }, 'send failed'));
  } catch (err) {
    log.warn({ err }, 'hypercareSend failed');
  }
}
