import { EmbedBuilder } from 'discord.js';
import logger from '../../logger.js';
import { SL_HYPERCARE_CHANNEL_ID, SL_HYPERCARE_VERBOSE } from './constants.js';

const log = logger.child({ module: 'sl-reward-hypercare' });

/**
 * Post an operational note to the hypercare channel during launch. Run summaries post
 * always; per-action detail passes verboseOnly:true so it can be silenced later by
 * flipping slReward.hypercareVerbose to false without a code change.
 */
export async function hypercareLog(client, { title, description, color = 0x3498db, verboseOnly = false }) {
  if (!SL_HYPERCARE_CHANNEL_ID) return;
  if (verboseOnly && !SL_HYPERCARE_VERBOSE) return;
  try {
    const channel = await client.channels.fetch(SL_HYPERCARE_CHANNEL_ID).catch(() => null);
    if (!channel) return;
    const embed = new EmbedBuilder().setTitle(title).setColor(color).setTimestamp(new Date());
    if (description) embed.setDescription(String(description).slice(0, 4000));
    await channel.send({ embeds: [embed] }).catch((e) => log.warn({ err: e?.message }, 'send failed'));
  } catch (err) {
    log.warn({ err }, 'hypercareLog failed');
  }
}
