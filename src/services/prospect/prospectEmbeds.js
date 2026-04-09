import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createEmbed } from '../../utils/embed.js';
import { isTestSteamId, getProspectDates } from './prospectService.js';
import config from '../../config.js';

export function buildProspectInfoEmbed(member, prospect, forumUrl) {
  const userTag = member?.user.tag || prospect.user_id;

  const steamId = prospect.steam_id;
  const steamLinks = !isTestSteamId(steamId)
    ? [
        `[steamid.com](https://www.steamid.com/lookup/${steamId})`,
        `[BattleMetrics](https://www.battlemetrics.com/rcon/players?filter[search]=${steamId})`,
        `[CBL](https://communitybanlist.com/search/${steamId})`,
      ].join(' | ')
    : steamId;

  const embed = createEmbed('Prospect')
    .setTitle('Prospect Application')
    .setDescription(`Applicant: **${userTag}** (<@${prospect.user_id}>)`)
    .addFields(
      { name: 'Alias', value: prospect.alias, inline: true },
      { name: 'Country', value: prospect.nationality, inline: true },
      { name: 'Date of Birth', value: prospect.date_of_birth, inline: true },
      { name: 'Hours in Squad', value: String(prospect.squad_hours), inline: true },
      { name: 'Preferred Roles', value: prospect.preferred_roles, inline: true },
      { name: 'Previous Clan', value: prospect.prev_clan, inline: true },
      { name: 'Why RB?', value: prospect.why_rb },
      { name: 'Active Hours (UTC)', value: prospect.active_hours, inline: true },
      { name: 'Competitive Interest', value: prospect.competitive, inline: true },
      { name: 'Links', value: steamLinks, inline: true },
    )
    .setColor(0x57f287);

  if (prospect.mentor_id) {
    embed.addFields({ name: 'Mentor', value: `<@${prospect.mentor_id}>`, inline: true });
  }

  if (prospect.forum_thread_id) {
    const { periodEnd, voteDate, isPaused } = getProspectDates(prospect);
    const extra = prospect.extra_days || 0;
    const pausedSuffix = isPaused ? ' (PAUSED)' : '';

    const endDateStr = `<t:${Math.floor(periodEnd.getTime() / 1000)}:D>${pausedSuffix}`;
    embed.addFields({ name: 'Period Ends', value: endDateStr, inline: true });

    const voteDateStr = `<t:${Math.floor(voteDate.getTime() / 1000)}:D>${pausedSuffix}`;
    embed.addFields({ name: 'Vote Date', value: voteDateStr, inline: true });

    if (extra > 0) {
      embed.addFields({ name: 'Extended', value: `+${extra} day(s)`, inline: true });
    }
  }

  if (forumUrl) {
    embed.addFields({ name: 'Forum Thread', value: `[View Thread](${forumUrl})`, inline: true });
  }

  if (member) {
    embed.setThumbnail(member.user.displayAvatarURL());
  }

  return embed;
}

export function buildForumIntroEmbed(member, prospect) {
  const userTag = member?.user.tag || 'Unknown';
  const { periodEnd, voteDate, isPaused } = getProspectDates(prospect);
  const pausedSuffix = isPaused ? ' (PAUSED)' : '';

  return createEmbed('Prospect')
    .setTitle(`${prospect.alias} - Prospect Application`)
    .setDescription(`Applicant: **${userTag}** (<@${prospect.user_id}>)`)
    .addFields(
      { name: 'Alias', value: prospect.alias, inline: true },
      { name: 'Country', value: prospect.nationality, inline: true },
      { name: 'Hours in Squad', value: String(prospect.squad_hours), inline: true },
      { name: 'Preferred Roles', value: prospect.preferred_roles, inline: true },
      { name: 'Previous Clan', value: prospect.prev_clan, inline: true },
      { name: 'Why RB?', value: prospect.why_rb },
      { name: 'Active Hours (UTC)', value: prospect.active_hours, inline: true },
      { name: 'Competitive Interest', value: prospect.competitive, inline: true },
      { name: 'Steam ID', value: prospect.steam_id, inline: true },
      { name: 'Period Ends', value: `<t:${Math.floor(periodEnd.getTime() / 1000)}:D>${pausedSuffix}`, inline: true },
      { name: 'Vote Date', value: `<t:${Math.floor(voteDate.getTime() / 1000)}:D>${pausedSuffix}`, inline: true },
    )
    .setColor(0x57f287)
    .setThumbnail(member?.user.displayAvatarURL() || null);
}

export function buildProspectComponents(prospect) {
  if (!prospect?.mentor_id) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('prospect_claim')
        .setLabel('Claim')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('💬'),
      new ButtonBuilder()
        .setCustomId('prospect_deny')
        .setLabel('Denied')
        .setStyle(ButtonStyle.Danger),
    );
    return [row];
  }

  const decisionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('prospect_accept')
      .setLabel('Accepted')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('prospect_deny')
      .setLabel('Denied')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('prospect_unclaim')
      .setLabel('Unclaim')
      .setStyle(ButtonStyle.Secondary),
  );

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('prospect_voice_invite')
      .setLabel('Invite to Voice')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🔊'),
  );

  return [decisionRow, actionRow];
}

export function buildProspectAcceptedComponents() {
  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('prospect_extend')
      .setLabel('Extend')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('prospect_test_vote')
      .setLabel('Force Vote')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('prospect_deny')
      .setLabel('Denied')
      .setStyle(ButtonStyle.Danger),
  );
  return [actionRow];
}

export function buildVoteAnnouncementEmbed(member, prospect, forumUrl) {
  return createEmbed('Prospect')
    .setTitle('Prospect Up for Voting')
    .setDescription(
      `**${prospect.alias}** is up for voting!\n\n` +
      `Head over to the [forum post](${forumUrl}) to cast your vote.`
    )
    .setColor(0xfee75c)
    .setThumbnail(member?.user.displayAvatarURL() || null);
}

export function buildAcceptedAnnouncementEmbed(member, prospect) {
  const { memberHubChannelId, meetTheMembersChannelId, goingAwayChannelId, feedbackChannelId } = config.prospects;

  const lines = [
    `Please join us in welcoming our newest member <@${prospect.user_id}>!\n`,
    'You can now view and vote on prospect tickets and you have been added to the whitelist.',
    feedbackChannelId
      ? `Also don\'t forget to give us feedback about your process in <#${feedbackChannelId}>.\n`
      : '',
    memberHubChannelId
      ? `📋 Check out <#${memberHubChannelId}> to know what we expect of you`
      : '',
    meetTheMembersChannelId
      ? `📝 Fill out <#${meetTheMembersChannelId}> so we can get to know a little about you`
      : '',
    goingAwayChannelId
      ? `✈️ Going away? Let us know in <#${goingAwayChannelId}> if you'll be away`
      : '',
  ].filter(Boolean).join('\n');

  return createEmbed('Prospect')
    .setTitle(`Welcome to Royal Battalion, ${prospect.alias}!`)
    .setDescription(lines)
    .setColor(0x57f287)
    .setThumbnail(member?.user.displayAvatarURL() || null);
}

export function buildVoteEmbed(prospect, playtimeStats = null) {
  const { periodEnd } = getProspectDates(prospect);
  const extra = prospect.extra_days || 0;
  const endDateStr = `<t:${Math.floor(periodEnd.getTime() / 1000)}:D>`;

  const embed = createEmbed('Prospect')
    .setTitle(`Vote - ${prospect.alias}`)
    .setDescription(
      `The prospect period for **${prospect.alias}** is coming to an end. Cast your vote!\n\n` +
      `Click a button below to vote.`
    )
    .addFields(
      { name: 'Voting ends', value: endDateStr, inline: true },
    )
    .setColor(0xfee75c);

  if (extra > 0) {
    embed.addFields({ name: 'Voting extended', value: `${extra} d`, inline: true });
  }

  if (playtimeStats) {
    embed.addFields(
      { name: 'Gameplay Hours', value: `${playtimeStats.playtimeHours}h`, inline: true },
      { name: 'Seeding Hours', value: `${playtimeStats.seedHours}h`, inline: true },
    );
  }

  if (prospect.mentor_id) {
    embed.addFields({ name: 'Mentor', value: `<@${prospect.mentor_id}>`, inline: true });
  }

  return embed;
}

export function buildVoteComponents(voteCounts) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('vote_yes')
      .setLabel(`Yes (${voteCounts.yes})`)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('vote_no')
      .setLabel(`No (${voteCounts.no})`)
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('vote_unsure')
      .setLabel(`Unsure (${voteCounts.unsure})`)
      .setStyle(ButtonStyle.Secondary),
  );
  return [row];
}

export function buildEndVoteComponents() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('vote_end')
      .setLabel('End Vote')
      .setStyle(ButtonStyle.Danger),
  );
  return [row];
}

export function buildCloseTicketComponents() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('prospect_close_ticket')
      .setLabel('Close Ticket')
      .setStyle(ButtonStyle.Danger),
  );
  return [row];
}
