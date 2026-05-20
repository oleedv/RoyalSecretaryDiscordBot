import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { query } from '../database/connection.js';
import { backfillForumThread } from '../services/prospect/prospectService.js';
import { successEmbed, errorEmbed } from '../utils/embed.js';
import config from '../config.js';
import logger from '../logger.js';

const log = logger.child({ module: 'cmd:backfill-prospect-forums' });
const OWNER_ID = '195412349153312768';

export default {
  data: new SlashCommandBuilder()
    .setName('backfill-prospect-forums')
    .setDescription('One-shot: pull forum-thread history into the DB for open prospects')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    if (interaction.user.id !== OWNER_ID) {
      return interaction.reply({ embeds: [errorEmbed('This command is restricted.')], flags: ['Ephemeral'] });
    }

    await interaction.deferReply({ flags: ['Ephemeral'] });

    const forumChannelId = config.prospects?.forumChannelId;
    if (!forumChannelId) {
      return interaction.editReply({ embeds: [errorEmbed('No forum channel configured.')] });
    }

    const forumChannel = await interaction.guild.channels.fetch(forumChannelId).catch(() => null);
    if (!forumChannel) {
      return interaction.editReply({ embeds: [errorEmbed('Forum channel not found.')] });
    }

    const rows = await query(
      `SELECT id, uuid, alias, forum_thread_id
         FROM prospects
        WHERE status = 'open' AND forum_thread_id IS NOT NULL`
    );

    if (rows.length === 0) {
      return interaction.editReply({ embeds: [successEmbed('No open prospects with forum threads.')] });
    }

    const results = [];
    for (const p of rows) {
      try {
        const thread = await forumChannel.threads.fetch(p.forum_thread_id).catch(() => null);
        if (!thread) {
          results.push(`- **${p.alias}**: skipped (thread not found)`);
          continue;
        }
        const { inserted, scanned } = await backfillForumThread(p.id, thread);
        results.push(`- **${p.alias}**: ${inserted} new / ${scanned} scanned`);
        log.info({ prospectId: p.id, inserted, scanned }, 'Forum backfill completed');
      } catch (err) {
        log.error({ err, prospectId: p.id }, 'Forum backfill failed');
        results.push(`- **${p.alias}**: error (${err.message})`);
      }
    }

    await interaction.editReply({ embeds: [successEmbed(results.join('\n'))] });
  },
};
