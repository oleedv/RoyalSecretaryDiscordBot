import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createEmbed } from '../../utils/embed.js';
import { isTestSteamId, getProspectDates } from './prospectService.js';
import config from '../../config.js';

export function buildProspectInfoEmbed(member, prospect, forumUrl, bmPlayerId = null) {
  const userTag = member?.user.tag || prospect.user_id;

  const steamId = prospect.steam_id;
  const steamLinks = !isTestSteamId(steamId)
    ? [
        `[steamid.com](https://www.steamid.com/profiles/${steamId})`,
        `[BattleMetrics](${bmPlayerId ? `https://www.battlemetrics.com/rcon/players/${bmPlayerId}` : `https://www.battlemetrics.com/rcon/players?filter[search]=${steamId}`})`,
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

  const descriptionLines = [
    `Please welcome our newest member <@${prospect.user_id}>!`,
    'You now have prospect voting access and have been added to the whitelist.',
  ];
  if (feedbackChannelId) {
    descriptionLines.push(`Don't forget to share feedback about your process in <#${feedbackChannelId}>.`);
  }

  const embed = createEmbed('Prospect')
    .setTitle(`Welcome to Royal Battalion, ${prospect.alias}!`)
    .setDescription(descriptionLines.join('\n\n'))
    .setColor(0x57f287)
    .setThumbnail(member?.user.displayAvatarURL() || null);

  if (memberHubChannelId) {
    embed.addFields({
      name: 'Check out',
      value: `<#${memberHubChannelId}> to know what we expect of you`,
      inline: true,
    });
  }
  if (meetTheMembersChannelId) {
    embed.addFields({
      name: 'Fill out',
      value: `<#${meetTheMembersChannelId}> so we can get to know a little about you`,
      inline: true,
    });
  }
  if (goingAwayChannelId) {
    embed.addFields({
      name: 'Going away?',
      value: `Let us know in <#${goingAwayChannelId}> if you'll be away`,
      inline: true,
    });
  }

  return embed;
}

export function buildVoteEmbed(prospect, stats = null) {
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

  const playtime = stats?.playtime;
  const combat = stats?.combat;
  const voice = stats?.voice;
  const messages = stats?.messages;
  const hasGameData = !isTestSteamId(prospect.steam_id);

  if (hasGameData && combat) {
    embed.addFields({
      name: 'Squad Combat',
      value: `Kills: **${combat.kills}**\nDeaths: **${combat.deaths}**\nTKs: **${combat.teamkills}**`,
      inline: true,
    });
  }

  if (hasGameData && (playtime || combat)) {
    const periodStart = new Date(prospect.period_started_at || prospect.created_at);
    const periodDaysElapsed = Math.max(1, Math.ceil((Date.now() - periodStart.getTime()) / 86400000));
    const gameplayHours = playtime ? `${playtime.playtimeHours}h` : '—';
    const seedingHours = playtime ? `${playtime.seedHours}h` : '—';
    const daysActive = combat ? `${combat.daysActive}/${periodDaysElapsed} days` : '—';
    embed.addFields({
      name: 'Server Time',
      value: `Gameplay: **${gameplayHours}**\nSeeding: **${seedingHours}**\nActive: **${daysActive}**`,
      inline: true,
    });
  }

  if (voice || messages) {
    const voiceHours = voice ? `${Math.round((voice.totalSeconds / 3600) * 10) / 10}h` : '—';
    const messageCount = messages ? messages.totalMessages : '—';
    embed.addFields({
      name: 'Discord',
      value: `Voice: **${voiceHours}**\nMessages: **${messageCount}**`,
      inline: true,
    });
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

const AI_SECTIONS = ['summary', 'flags', 'positives'];
const AI_SECTION_LABELS = { summary: 'Summary', flags: 'Flags', positives: 'Positives' };
const AI_DEFAULT_SECTION = 'summary';

export function parseAiSections(text) {
  const sections = { flags: '', positives: '', summary: '' };
  if (!text) return sections;

  const pattern = /\*\*(Flags|Positives|Summary)\s*:?\s*\*\*\s*\n?/gi;
  const matches = [];
  let m;
  while ((m = pattern.exec(text)) !== null) {
    matches.push({ key: m[1].toLowerCase(), start: m.index, end: m.index + m[0].length });
  }

  for (let i = 0; i < matches.length; i++) {
    const end = i + 1 < matches.length ? matches[i + 1].start : text.length;
    sections[matches[i].key] = text.slice(matches[i].end, end).trim();
  }

  return sections;
}

export function buildProspectAiEmbed(section, sections) {
  const key = AI_SECTIONS.includes(section) ? section : AI_DEFAULT_SECTION;
  const label = AI_SECTION_LABELS[key];
  const body = sections[key] || '*Not provided.*';
  const truncated = body.length > 4096 ? body.slice(0, 4093) + '...' : body;

  return createEmbed('Prospect')
    .setTitle(`AI Assessment — ${label}`)
    .setDescription(truncated)
    .setColor(0x5865f2);
}

export function buildProspectAiTabRow(prospectId, activeSection) {
  const active = AI_SECTIONS.includes(activeSection) ? activeSection : AI_DEFAULT_SECTION;
  const row = new ActionRowBuilder();
  for (const key of AI_SECTIONS) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`prospect_ai_tab:${key}:${prospectId}`)
        .setLabel(AI_SECTION_LABELS[key])
        .setStyle(key === active ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(key === active),
    );
  }
  return row;
}

export { AI_DEFAULT_SECTION };

export function buildCloseTicketComponents() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('prospect_close_ticket')
      .setLabel('Close Ticket')
      .setStyle(ButtonStyle.Danger),
  );
  return [row];
}
