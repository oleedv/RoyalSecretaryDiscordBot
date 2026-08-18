import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createEmbed, infoEmbed, successEmbed } from '../../utils/embed.js';
import { buildVoteEmbed, buildVoteComponents, buildVoteAnnouncementEmbed, buildEndVoteComponents, buildCloseTicketComponents } from './prospectEmbeds.js';
import { isTestSteamId, getProspectDates, closeProspect } from './prospectService.js';
import { findBotMessageByCustomId } from '../../utils/messageSearch.js';
import { query } from '../../database/connection.js';
import { getPlaytime } from '../playtimeService.js';
import { getProspectStats } from '../squadStats/combatStatsService.js';
import { getVoiceStats, getMessageStats } from '../activity/activityService.js';
import * as whitelistService from '../whitelistService.js';
import { evaluateVoteOutcome } from './prospectVoteRules.js';
import { getProspectConfig } from './prospectConfig.js';
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
    counts[row.vote] = Number(row.count);
  }
  return counts;
}

export async function postVote(prospect, client) {
  const guild = await client.guilds.fetch(config.guild.id);
  if (!guild) return;

  const { forumChannelId, memberRoleId } = config.prospects;
  // memberRoleId is intentionally NOT granted here — see closeProspect for member-role assignment on accept.
  if (!forumChannelId || !prospect.forum_thread_id) return;

  const forumChannel = await guild.channels.fetch(forumChannelId).catch(() => null);
  if (!forumChannel) return;

  const thread = await forumChannel.threads.fetch(prospect.forum_thread_id).catch(() => null);
  if (!thread) return;

  const { forumTags } = config.prospects;
  const openForVoteTagId = forumTags?.openForVote ?? null;
  if (openForVoteTagId && !thread.appliedTags?.includes(openForVoteTagId)) {
    const needFeedbackTagId = forumTags?.needFeedback ?? null;
    const next = (thread.appliedTags ?? [])
      .filter((id) => id !== needFeedbackTagId)
      .concat(openForVoteTagId);
    await thread.setAppliedTags(next).catch((err) =>
      log.warn({ err, threadId: thread.id }, 'Failed to set Open for Vote tag')
    );
  }

  const periodStartIso = new Date(prospect.period_started_at || prospect.created_at).toISOString().slice(0, 10);
  const nowIso = new Date().toISOString().slice(0, 10);

  let playtimeStats = null;
  let combatStats = null;
  if (!isTestSteamId(prospect.steam_id)) {
    [playtimeStats, combatStats] = await Promise.all([
      getPlaytime(prospect.steam_id, periodStartIso, nowIso).catch(() => null),
      getProspectStats(prospect.steam_id, periodStartIso, nowIso).catch(() => null),
    ]);
  }

  const [voiceStats, messageStats] = await Promise.all([
    getVoiceStats(prospect.user_id, periodStartIso, nowIso).catch(() => null),
    getMessageStats(prospect.user_id, periodStartIso, nowIso).catch(() => null),
  ]);

  const liveForVote = await getProspectConfig();
  const voteEmbed = buildVoteEmbed(prospect, {
    playtime: playtimeStats,
    combat: combatStats,
    voice: voiceStats,
    messages: messageStats,
    voteAcceptHours: liveForVote.voteAcceptHours,
  });
  const counts = { yes: 0, no: 0, unsure: 0 };
  const components = buildVoteComponents(counts);
  const voteMsg = await thread.send({
    content: memberRoleId ? `<@&${memberRoleId}>` : undefined,
    embeds: [voteEmbed],
    components,
    allowedMentions: { roles: memberRoleId ? [memberRoleId] : [] },
  });

  const liveForDates = await getProspectConfig();
  const { periodEnd } = getProspectDates(prospect, liveForDates.periodDays);
  // Guarantee the whitelist entry covers the full vote window even if the vote starts late
  // (force-vote or delayed by low playtime). Anchor expiry to max(periodEnd, now + voteDaysBefore).
  const minExpiry = new Date(Date.now() + (config.prospects.voteDaysBefore || 14) * 24 * 60 * 60 * 1000);
  const whitelistExpiry = periodEnd > minExpiry ? periodEnd : minExpiry;
  if (!isTestSteamId(prospect.steam_id)) {
    whitelistService.createEntry(prospect.steam_id, prospect.alias, 'RB', 'Prospect', client.user.id, whitelistExpiry)
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
    const expiryUnix = Math.floor(whitelistExpiry.getTime() / 1000);
    const whitelistLine = `\nProspect whitelist granted on the game server, auto-expires <t:${expiryUnix}:R>.`;
    const notifEmbed = createEmbed('Prospect')
      .setTitle('Vote Started')
      .setDescription(
        `A vote has been posted in the [forum thread](https://discord.com/channels/${guild.id}/${prospect.forum_thread_id}/${voteMsg.id}).` +
        whitelistLine
      )
      .setColor(0xfee75c);
    const endVoteComponents = buildEndVoteComponents();
    await staffChannel.send({ embeds: [notifEmbed], components: endVoteComponents, allowedMentions: { parse: [] } });
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

export async function finalizeVote(prospect, actorId, client, guild) {
  const counts = await getVoteCounts(prospect.id);

  const live = await getProspectConfig();
  const MIN_VOTES = live.minYesVotes;
  const MIN_RATE = live.minYesRate;
  const acceptHours = live.voteAcceptHours;

  let playtimeHours = null;
  if (!isTestSteamId(prospect.steam_id)) {
    const periodStartIso = new Date(prospect.period_started_at || prospect.created_at).toISOString().slice(0, 10);
    const nowIso = new Date().toISOString().slice(0, 10);
    const stats = await getPlaytime(prospect.steam_id, periodStartIso, nowIso).catch(() => null);
    playtimeHours = stats ? stats.playtimeHours : null;
  }

  const judged = evaluateVoteOutcome({
    yes: counts.yes,
    no: counts.no,
    playtimeHours,
    isTestSteamId: isTestSteamId(prospect.steam_id),
    minYesVotes: MIN_VOTES,
    minYesRate: MIN_RATE,
    voteAcceptHours: acceptHours,
  });
  const outcome = judged.outcome;

  const staffChannel = await guild.channels.fetch(prospect.channel_id).catch(() => null);

  if (judged.hoursUnverified && staffChannel) {
    await staffChannel.send({
      embeds: [infoEmbed(`Could not verify gameplay hours; the ${acceptHours}-hour accept rule was skipped.`)],
    }).catch(() => null);
  }

  if (outcome === 'denied' && staffChannel) {
    const warnings = [];
    if (!judged.votesOk) {
      const totalVotes = counts.yes + counts.no;
      const yesRate = totalVotes > 0 ? counts.yes / totalVotes : 0;
      if (counts.yes < MIN_VOTES) warnings.push(`${counts.yes}/${MIN_VOTES} minimum yes votes`);
      if (yesRate < MIN_RATE) warnings.push(`${Math.round(yesRate * 100)}% of ${Math.round(MIN_RATE * 100)}% required yes rate`);
    }
    if (!judged.hoursOk) warnings.push(`${playtimeHours}/${acceptHours} required gameplay hours`);
    if (warnings.length > 0) {
      await staffChannel.send({
        embeds: [infoEmbed(`Thresholds not met: ${warnings.join(', ')}. Prospect will be **denied**.`)],
      }).catch(() => null);
    }
  }

  const reason = outcome === 'denied' ? judged.denyReason : undefined;
  await closeProspect(prospect, actorId, outcome, guild, reason);

  if (staffChannel) {
    const endVoteMsg = await findBotMessageByCustomId(staffChannel, client.user.id, ['vote_end']);
    if (endVoteMsg) {
      const disabledRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('vote_end')
          .setLabel('Vote Ended')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
      );
      await endVoteMsg.edit({ components: [disabledRow] }).catch(() => null);
    }

    await staffChannel.send({
      embeds: [successEmbed(`Vote ended for **${prospect.alias}** - result: ${counts.yes} yes, ${counts.no} no, ${counts.unsure} unsure - outcome: **${outcome}**.`)],
      components: buildCloseTicketComponents(),
    }).catch(() => null);
  }

  log.info({ prospectId: prospect.id, outcome, counts, actorId }, 'Vote finalized');
  return { outcome, counts };
}
