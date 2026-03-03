import { createEmbed } from '../../utils/embed.js';
import { buildVoteEmbed, buildVoteComponents, buildVoteAnnouncementEmbed, buildEndVoteComponents } from './prospectEmbeds.js';
import { query } from '../../database/connection.js';
import { resolveAndGetStats } from '../battlemetricsService.js';
import * as whitelistService from '../whitelistService.js';
import config from '../../config.js';
import logger from '../../logger.js';

const log = logger.child({ module: 'prospectVoting' });

export async function getProspectByVoteMessage(messageId) {
  const rows = await query(
    'SELECT * FROM prospects WHERE vote_message_id = ? AND status = ?',
    [messageId, 'open']
  );
  return rows[0] || null;
}

export async function upsertVote(prospectId, voterId, voterTag, vote, reason = null) {
  await query(
    `INSERT INTO prospect_votes (prospect_id, voter_id, voter_tag, vote, reason) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE vote = VALUES(vote), voter_tag = VALUES(voter_tag), reason = VALUES(reason), created_at = NOW()`,
    [prospectId, voterId, voterTag, vote, reason]
  );
}

export async function getVoteCounts(prospectId) {
  const rows = await query(
    `SELECT vote, COUNT(*) as count FROM prospect_votes WHERE prospect_id = ? GROUP BY vote`,
    [prospectId]
  );
  const counts = { yes: 0, no: 0, unsure: 0 };
  for (const row of rows) {
    counts[row.vote] = row.count;
  }
  return counts;
}

export async function postVote(prospect, client) {
  const guild = await client.guilds.fetch(config.guild.id);
  if (!guild) return;

  const { forumChannelId, whitelistRoleId } = config.prospects;
  if (!forumChannelId || !prospect.forum_thread_id) return;

  const forumChannel = await guild.channels.fetch(forumChannelId).catch(() => null);
  if (!forumChannel) return;

  const thread = await forumChannel.threads.fetch(prospect.forum_thread_id).catch(() => null);
  if (!thread) return;

  let bmStats = null;
  if (prospect.steam_id && prospect.steam_id.toUpperCase() !== 'Q') {
    const startDate = new Date(prospect.created_at).toISOString().slice(0, 10);
    const endDate = new Date().toISOString().slice(0, 10);
    bmStats = await resolveAndGetStats(prospect.steam_id, startDate, endDate).catch(() => null);
  }

  const voteEmbed = buildVoteEmbed(prospect, bmStats);
  const counts = { yes: 0, no: 0, unsure: 0 };
  const components = buildVoteComponents(counts);
  const voteMsg = await thread.send({ embeds: [voteEmbed], components });

  if (whitelistRoleId) {
    const member = await guild.members.fetch(prospect.user_id).catch(() => null);
    if (member) {
      await member.roles.add(whitelistRoleId).catch((err) =>
        log.error({ err, userId: prospect.user_id }, 'Failed to add whitelist role')
      );
    }
  }

  if (prospect.steam_id && prospect.steam_id.toUpperCase() !== 'Q') {
    whitelistService.createEntry(prospect.steam_id, prospect.alias, 'RB', 'Prospect', client.user.id)
      .catch((err) => log.warn({ err }, 'Failed to create prospect whitelist entry'));
  }

  await query(
    'UPDATE prospects SET vote_posted_at = NOW(), vote_message_id = ? WHERE id = ?',
    [voteMsg.id, prospect.id]
  );

  await query(
    'INSERT INTO prospect_events (prospect_id, event_type, actor_id, detail) VALUES (?, ?, ?, ?)',
    [prospect.id, 'vote_started', client.user.id, `Vote message: ${voteMsg.id}`]
  );

  const user = await client.users.fetch(prospect.user_id).catch(() => null);
  if (user) {
    const dmEmbed = createEmbed('Prospect')
      .setTitle('Voting Started')
      .setDescription(
        'Your prospect period is coming to an end and you have been put up for voting.\n' +
        'Members are now casting their votes on your membership in **Royal Battalion**.'
      )
      .setColor(0xfee75c);
    await user.send({ embeds: [dmEmbed] }).catch(() => null);
  }

  const staffChannel = await guild.channels.fetch(prospect.channel_id).catch(() => null);
  if (staffChannel) {
    const notifEmbed = createEmbed('Prospect')
      .setTitle('Vote Started')
      .setDescription(`A vote has been posted in the [forum thread](https://discord.com/channels/${guild.id}/${prospect.forum_thread_id}/${voteMsg.id}).`)
      .setColor(0xfee75c);
    const endVoteComponents = buildEndVoteComponents();
    await staffChannel.send({ embeds: [notifEmbed], components: endVoteComponents });
  }

  const { loungeChannelId } = config.prospects;
  if (loungeChannelId) {
    const loungeChannel = await guild.channels.fetch(loungeChannelId).catch(() => null);
    if (loungeChannel) {
      const member = await guild.members.fetch(prospect.user_id).catch(() => null);
      const forumUrl = `https://discord.com/channels/${guild.id}/${prospect.forum_thread_id}`;
      const announceEmbed = buildVoteAnnouncementEmbed(member, prospect, forumUrl);
      await loungeChannel.send({ embeds: [announceEmbed] }).catch((err) =>
        log.error({ err, prospectId: prospect.id }, 'Failed to send vote announcement to lounge')
      );
    }
  }

  log.info({ prospectId: prospect.id, voteMessageId: voteMsg.id }, 'Vote posted');
}
