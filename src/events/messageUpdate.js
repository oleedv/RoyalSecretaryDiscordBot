import { Events } from 'discord.js';
import { createEmbed } from '../utils/embed.js';
import { getOpenTicketByUser, getMessageBySourceId } from '../services/ticket/ticketService.js';
import config from '../config.js';
import logger from '../logger.js';

const log = logger.child({ module: 'messageUpdate' });

const MAX_FIELDS = 25;

export default {
  name: Events.MessageUpdate,

  async execute(oldMessage, newMessage) {
    try {
      if (newMessage.partial) {
        try { newMessage = await newMessage.fetch(); } catch { return; }
      }

      if (newMessage.author?.bot) return;
      if (newMessage.guild) return;

      const ticket = await getOpenTicketByUser(newMessage.author.id);
      if (!ticket) return;

      const tracked = await getMessageBySourceId(newMessage.id);
      if (!tracked) return;

      const guild = await newMessage.client.guilds.fetch(config.guild.id);
      if (!guild) return;

      const channel = await guild.channels.fetch(ticket.channel_id).catch(() => null);
      if (!channel) return;

      const channelMsg = await channel.messages.fetch(tracked.channel_message_id).catch(() => null);
      if (!channelMsg) return;

      const originalEmbed = channelMsg.embeds[0];
      if (!originalEmbed) return;

      const existingFields = originalEmbed.fields || [];
      const editCount = existingFields.filter((f) => f.name.startsWith('Edit')).length;
      const previousContent = originalEmbed.description || '*empty*';

      const newField = {
        name: editCount === 0 ? 'Edit' : `Edit ${editCount + 1}`,
        value: previousContent.slice(0, 1024),
      };

      if (existingFields.length + 1 > MAX_FIELDS) {
        const overflow = createEmbed('Ticket')
          .setAuthor({ name: newMessage.author.tag, iconURL: newMessage.author.displayAvatarURL() })
          .setDescription(newMessage.content || '*empty*')
          .setColor(0xfee75c)
          .addFields(newField);

        await channel.send({ embeds: [overflow] });
        log.debug({ ticketId: ticket.id }, 'Edit overflowed to new embed');
        return;
      }

      const rebuilt = createEmbed('Ticket')
        .setAuthor({
          name: originalEmbed.author?.name || newMessage.author.tag,
          iconURL: originalEmbed.author?.iconURL || newMessage.author.displayAvatarURL(),
        })
        .setDescription(newMessage.content || '*empty*')
        .setColor(originalEmbed.color ?? 0x57f287);

      if (originalEmbed.image) {
        rebuilt.setImage(originalEmbed.image.url);
      }

      const updatedFields = existingFields.map((f) =>
        f.name === 'Edit' && editCount > 0 ? { ...f, name: 'Edit 1' } : f
      );

      rebuilt.addFields(...updatedFields, newField);

      await channelMsg.edit({ embeds: [rebuilt] });

      log.debug({ ticketId: ticket.id, editCount: editCount + 1, userId: newMessage.author.id }, 'DM edit applied to original embed');
    } catch (err) {
      log.error({ err }, 'Error handling message update');
    }
  },
};
