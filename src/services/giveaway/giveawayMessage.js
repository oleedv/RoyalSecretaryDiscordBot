import { countEntries } from './giveawayService.js';
import { buildEntryEmbed, buildEntryRow } from './giveawayEmbeds.js';
import logger from '../../logger.js';

const log = logger.child({ module: 'giveawayMessage' });

/**
 * Re-renders the public entry message for a giveaway with the live entry count.
 * Called after every new entry (button enter + staff manual add) so "Entries so far"
 * stays current.
 *
 * Best-effort: never throws. A failed refresh must not break the entrant's flow.
 *
 * @param {import('discord.js').Client} client
 * @param {object} giveaway  Full giveaway row (needs entry_channel_id + entry_message_id).
 */
export async function refreshEntryMessage(client, giveaway) {
  if (!giveaway?.entry_channel_id || !giveaway?.entry_message_id) return;

  try {
    const count = await countEntries(giveaway.id);

    const channel = await client.channels.fetch(giveaway.entry_channel_id).catch(() => null);
    if (!channel) {
      log.warn({ giveawayId: giveaway.id, channelId: giveaway.entry_channel_id }, 'Entry channel not found - skipping refresh');
      return;
    }

    const message = await channel.messages.fetch(giveaway.entry_message_id).catch(() => null);
    if (!message) {
      log.warn({ giveawayId: giveaway.id, messageId: giveaway.entry_message_id }, 'Entry message not found - skipping refresh');
      return;
    }

    await message.edit({
      embeds: [buildEntryEmbed(giveaway, count)],
      components: [buildEntryRow(giveaway.id)],
    });
  } catch (err) {
    log.warn({ err, giveawayId: giveaway.id }, 'Failed to refresh entry message');
  }
}
