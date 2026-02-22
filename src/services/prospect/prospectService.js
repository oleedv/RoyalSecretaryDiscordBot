import { randomUUID } from 'crypto';
import { ChannelType, EmbedBuilder } from 'discord.js';
import { createEmbed } from '../../utils/embed.js';
import { buildPrivateChannelPermissions } from '../../utils/permissions.js';
import { findBotMessageByCustomId } from '../../utils/messageSearch.js';
import { buildProspectInfoEmbed, buildForumIntroEmbed, buildProspectComponents, buildProspectAcceptedComponents, buildAcceptedAnnouncementEmbed } from './prospectEmbeds.js';
import { query } from '../../database/connection.js';
import config from '../../config.js';
import logger from '../../logger.js';

const log = logger.child({ module: 'prospects' });

// ── CBL GraphQL ──

async function fetchCblData(steamId) {
  try {
    log.info({ steamId }, 'CBL: fetching data');
    const res = await fetch('https://communitybanlist.com/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query {
          steamUser(id: "${steamId}") {
            id
            riskRating
            reputationPoints
            bans(expired: false, first: 10) {
              edges {
                node {
                  id
                  reason
                  created
                  expires
                  banList {
                    name
                    organisation { name }
                  }
                }
              }
            }
            expiredBans: bans(expired: true, first: 0) {
              edges { node { id } }
            }
          }
        }`,
      }),
    });
    if (!res.ok) {
      log.warn({ steamId, status: res.status }, 'CBL: API returned non-OK status');
      return null;
    }
    const json = await res.json();
    log.info({ steamId, response: JSON.stringify(json) }, 'CBL: raw API response');
    return json?.data?.steamUser ?? null;
  } catch (err) {
    log.warn({ err, steamId }, 'CBL: fetch failed');
    return null;
  }
}

function formatCblEmbed(cblData) {
  const riskRating = cblData?.riskRating ?? 0;
  const repPoints = cblData?.reputationPoints ?? 0;
  const bans = cblData?.bans?.edges?.map((e) => e.node) ?? [];

  const expiredCount = cblData?.expiredBans?.edges?.length ?? 0;

  let text = `**Risk:** ${riskRating}/10 · **Rep:** ${repPoints} pts · **Expired Bans:** ${expiredCount}`;

  if (bans.length === 0) {
    text += '\nNo active bans';
  } else {
    text += `\n**Active Bans (${bans.length}):**`;
    for (const ban of bans) {
      const org = ban.banList?.organisation?.name || 'Unknown';
      const list = ban.banList?.name || 'Unknown';
      const reason = ban.reason || 'No reason';
      const created = ban.created ? `<t:${Math.floor(new Date(ban.created).getTime() / 1000)}:d>` : '?';
      const expiry = ban.expires
        ? `expires <t:${Math.floor(new Date(ban.expires).getTime() / 1000)}:d>`
        : 'permanent';
      text += `\n> **${org}** — ${list}\n> ${reason} (${created}, ${expiry})`;
    }
  }

  return text;
}

function appendCblToMessage(message, steamId) {
  if (!steamId || steamId.toUpperCase() === 'Q') return;

  log.info({ steamId }, 'CBL: starting background fetch');
  fetchCblData(steamId).then((cblData) => {
    const text = formatCblEmbed(cblData);
    log.info({ steamId }, 'CBL: appending to embed');

    const embed = message.embeds[0];
    if (!embed) {
      log.warn('CBL: message has no embeds to update');
      return;
    }

    const updated = EmbedBuilder.from(embed).addFields({ name: 'Community Ban List', value: text });
    message.edit({ embeds: [updated] }).catch((err) =>
      log.warn({ err }, 'CBL: failed to edit message')
    );
  }).catch((err) => {
    log.warn({ err, steamId }, 'CBL: appendCblToMessage failed');
  });
}

// ── DB Accessors ──

export async function getOpenProspectByUser(userId) {
  const rows = await query(
    'SELECT * FROM prospects WHERE user_id = ? AND status = ?',
    [userId, 'open']
  );
  return rows[0] || null;
}

export async function getProspectByChannel(channelId) {
  const rows = await query(
    'SELECT * FROM prospects WHERE channel_id = ? AND status = ?',
    [channelId, 'open']
  );
  return rows[0] || null;
}

export async function getProspectsNeedingVote() {
  const { periodDays, voteDaysBefore } = config.prospects;
  const daysUntilVote = periodDays - voteDaysBefore;
  return await query(
    'SELECT * FROM prospects WHERE status = ? AND forum_thread_id IS NOT NULL AND vote_posted_at IS NULL AND paused_at IS NULL AND TIMESTAMPDIFF(DAY, created_at, NOW()) >= (? + COALESCE(extra_days, 0))',
    ['open', daysUntilVote]
  );
}

export async function saveProspectMessage(prospectId, authorId, authorTag, content, attachments, isStaff, sourceMessageId, channelMessageId) {
  await query(
    'INSERT INTO prospect_messages (prospect_id, author_id, author_tag, content, attachments, is_staff, source_message_id, channel_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [prospectId, authorId, authorTag, content, JSON.stringify(attachments || []), isStaff ? 1 : 0, sourceMessageId || null, channelMessageId || null]
  );
}

// ── Operations ──

export async function createProspect(userId, guild, formData) {
  const existing = await getOpenProspectByUser(userId);
  if (existing) return { error: 'You already have an open prospect application.' };

  const uuid = randomUUID();
  const shortId = uuid.slice(0, 6);
  const { categoryId, roles, prospectRoleId, mentorRoleId } = config.prospects;

  const permissionOverwrites = buildPrivateChannelPermissions(guild, roles);

  const channel = await guild.channels.create({
    name: `prospect-${formData.alias.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${shortId}`,
    type: ChannelType.GuildText,
    parent: categoryId || undefined,
    permissionOverwrites,
  });

  await query(
    `INSERT INTO prospects (uuid, channel_id, user_id, alias, nationality, date_of_birth, squad_hours, preferred_roles, prev_clan, why_rb, active_hours, competitive, steam_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuid, channel.id, userId, formData.alias, formData.nationality, formData.dateOfBirth, formData.squadHours, formData.preferredRoles, formData.prevClan, formData.whyRb, formData.activeHours, formData.competitive, formData.steamId]
  );

  const rows = await query('SELECT * FROM prospects WHERE uuid = ?', [uuid]);
  const prospect = rows[0];

  await query(
    'INSERT INTO prospect_events (prospect_id, event_type, actor_id) VALUES (?, ?, ?)',
    [prospect.id, 'created', userId]
  );

  const member = await guild.members.fetch(userId).catch(() => null);
  const infoEmbed = buildProspectInfoEmbed(member, prospect);
  const components = buildProspectComponents(prospect);

  const topMsg = await channel.send({ embeds: [infoEmbed], components });
  appendCblToMessage(topMsg, prospect.steam_id);

  if (mentorRoleId) {
    await channel.send(`<@&${mentorRoleId}> New prospect application!`);
  }

  if (prospectRoleId && member) {
    await member.roles.add(prospectRoleId).catch((err) =>
      log.error({ err, userId }, 'Failed to add prospect role')
    );
  }

  const user = await guild.client.users.fetch(userId).catch(() => null);
  if (user) {
    await user.send(
      `**[Prospect]** Your application to **Royal Battalion** has been received! A mentor will contact you shortly.`
    ).catch(() => null);
  }

  log.info({ uuid, userId, channelId: channel.id }, 'Prospect created');
  return { prospect, channel };
}

export async function claimProspect(prospect, mentorId, guild) {
  if (prospect.mentor_id) return { error: 'This prospect already has a mentor.' };

  await query('UPDATE prospects SET mentor_id = ? WHERE id = ?', [mentorId, prospect.id]);

  const mentor = await guild.members.fetch(mentorId).catch(() => null);
  const mentorTag = mentor?.user.tag || mentorId;

  const staffChannel = await guild.channels.fetch(prospect.channel_id).catch(() => null);
  if (staffChannel) {
    const member = await guild.members.fetch(prospect.user_id).catch(() => null);
    const updated = (await query('SELECT * FROM prospects WHERE id = ?', [prospect.id]))[0];
    const infoEmbed = buildProspectInfoEmbed(member, updated);
    const components = buildProspectComponents(updated);

    const topMsg = await findBotMessageByCustomId(staffChannel, guild.client.user.id, ['prospect_claim', 'prospect_accept', 'prospect_deny']);
    if (topMsg) {
      await topMsg.edit({ embeds: [infoEmbed], components });
      appendCblToMessage(topMsg, updated.steam_id);
    }

    const notifEmbed = createEmbed('Prospect')
      .setTitle('Mentor Assigned')
      .setDescription(`**${mentorTag}** has claimed this prospect. DM relay is now active.`)
      .setColor(0x5865f2);
    await staffChannel.send({ embeds: [notifEmbed] });
  }

  const user = await guild.client.users.fetch(prospect.user_id).catch(() => null);
  if (user) {
    await user.send(
      `**[Prospect]** A mentor has been assigned to you! You can now communicate with them by sending messages here in DMs.`
    ).catch(() => null);
  }

  log.info({ prospectId: prospect.id, mentorId }, 'Mentor claimed prospect');
  return {};
}

export async function unclaimProspect(prospect, actorId, guild) {
  if (!prospect.mentor_id) return { error: 'This prospect does not have a mentor.' };

  await query('UPDATE prospects SET mentor_id = NULL WHERE id = ?', [prospect.id]);

  await query(
    'INSERT INTO prospect_events (prospect_id, event_type, actor_id) VALUES (?, ?, ?)',
    [prospect.id, 'unclaimed', actorId]
  );

  const staffChannel = await guild.channels.fetch(prospect.channel_id).catch(() => null);
  if (staffChannel) {
    const member = await guild.members.fetch(prospect.user_id).catch(() => null);
    const updated = (await query('SELECT * FROM prospects WHERE id = ?', [prospect.id]))[0];
    const infoEmbed = buildProspectInfoEmbed(member, updated);
    const components = buildProspectComponents(updated);

    const topMsg = await findBotMessageByCustomId(staffChannel, guild.client.user.id, ['prospect_claim', 'prospect_accept', 'prospect_deny', 'prospect_unclaim']);
    if (topMsg) {
      await topMsg.edit({ embeds: [infoEmbed], components });
      appendCblToMessage(topMsg, updated.steam_id);
    }

    const actor = await guild.members.fetch(actorId).catch(() => null);
    const actorTag = actor?.user.tag || actorId;
    const notifEmbed = createEmbed('Prospect')
      .setTitle('Mentor Unclaimed')
      .setDescription(`**${actorTag}** has unclaimed this prospect. DM relay is no longer active.`)
      .setColor(0xed4245);
    await staffChannel.send({ embeds: [notifEmbed] });
  }

  log.info({ prospectId: prospect.id, actorId }, 'Mentor unclaimed prospect');
  return {};
}

export async function acceptProspect(prospect, acceptedById, guild) {
  const { forumChannelId, periodDays } = config.prospects;

  const member = await guild.members.fetch(prospect.user_id).catch(() => null);

  let forumThreadId = null;
  const forumChannel = forumChannelId ? await guild.channels.fetch(forumChannelId).catch(() => null) : null;
  if (forumChannel) {
    const introEmbed = buildForumIntroEmbed(member, prospect);

    const thread = await forumChannel.threads.create({
      name: `${prospect.alias} — Prospect Application`,
      message: { embeds: [introEmbed] },
    });
    forumThreadId = thread.id;
  }

  await query(
    'UPDATE prospects SET forum_thread_id = ?, created_at = NOW() WHERE id = ?',
    [forumThreadId, prospect.id]
  );

  await query(
    'INSERT INTO prospect_events (prospect_id, event_type, actor_id, detail) VALUES (?, ?, ?, ?)',
    [prospect.id, 'accepted', acceptedById, 'Interview passed — prospect period started']
  );

  const staffChannel = await guild.channels.fetch(prospect.channel_id).catch(() => null);
  if (staffChannel) {
    const forumUrl = forumThreadId ? `https://discord.com/channels/${guild.id}/${forumThreadId}` : null;

    const updated = (await query('SELECT * FROM prospects WHERE id = ?', [prospect.id]))[0];
    const infoEmbed = buildProspectInfoEmbed(member, updated, forumUrl);
    const components = buildProspectAcceptedComponents(updated);

    const topMsg = await findBotMessageByCustomId(staffChannel, guild.client.user.id, ['prospect_accept', 'prospect_deny']);
    if (topMsg) {
      await topMsg.edit({ embeds: [infoEmbed], components });
      appendCblToMessage(topMsg, updated.steam_id);
    }

    const notifEmbed = createEmbed('Prospect')
      .setTitle('Prospect Accepted')
      .setDescription(
        `**${prospect.alias}** has been accepted. Prospect period started (${periodDays} days).` +
        (forumThreadId ? `\n[View Forum Thread](https://discord.com/channels/${guild.id}/${forumThreadId})` : '')
      )
      .setColor(0x57f287);
    await staffChannel.send({ embeds: [notifEmbed] });
  }

  if (member) {
    await member.setNickname(`P | ${member.displayName}`).catch((err) =>
      log.warn({ err, userId: prospect.user_id }, 'Failed to set P | nickname')
    );
  }

  const user = await guild.client.users.fetch(prospect.user_id).catch(() => null);
  if (user) {
    await user.send(
      `**[Prospect]** Great news! You've passed the interview and have been **accepted** as a prospect in **Royal Battalion**! Your prospect period has now started.`
    ).catch(() => null);
  }

  log.info({ prospectId: prospect.id, acceptedBy: acceptedById, forumThreadId }, 'Prospect accepted, forum thread created');
}

export async function closeProspect(prospect, closedById, outcome, guild, reason) {
  const statusMap = { accepted: 'accepted', denied: 'denied', closed: 'closed' };
  const status = statusMap[outcome] || 'closed';

  await query(
    'UPDATE prospects SET status = ?, closed_at = NOW(), closed_by = ? WHERE id = ?',
    [status, closedById, prospect.id]
  );

  await query(
    'INSERT INTO prospect_events (prospect_id, event_type, actor_id, detail) VALUES (?, ?, ?, ?)',
    [prospect.id, status === 'closed' ? 'closed' : status, closedById, reason || null]
  );

  if (prospect.forum_thread_id) {
    const { forumChannelId } = config.prospects;
    const forumChannel = forumChannelId ? await guild.channels.fetch(forumChannelId).catch(() => null) : null;
    if (forumChannel) {
      const thread = await forumChannel.threads.fetch(prospect.forum_thread_id).catch(() => null);
      if (thread) {
        await thread.delete().catch((err) =>
          log.error({ err, threadId: prospect.forum_thread_id }, 'Failed to delete forum thread')
        );
      }
    }
  }

  const { prospectRoleId, whitelistRoleId } = config.prospects;
  const member = await guild.members.fetch(prospect.user_id).catch(() => null);
  if (member) {
    if (prospectRoleId) await member.roles.remove(prospectRoleId).catch(() => null);
    if (whitelistRoleId) await member.roles.remove(whitelistRoleId).catch(() => null);

    if (outcome === 'accepted') {
      const strippedName = member.displayName.replace(/^P \| /, '');
      await member.setNickname(`RB | ${strippedName}`).catch((err) =>
        log.warn({ err, userId: prospect.user_id }, 'Failed to set RB | nickname')
      );
    } else {
      const currentName = member.displayName;
      if (currentName.startsWith('P | ')) {
        await member.setNickname(currentName.replace(/^P \| /, '')).catch((err) =>
          log.warn({ err, userId: prospect.user_id }, 'Failed to strip P | nickname')
        );
      }
    }
  }

  if (outcome === 'accepted') {
    const { loungeChannelId } = config.prospects;
    if (loungeChannelId) {
      const loungeChannel = await guild.channels.fetch(loungeChannelId).catch(() => null);
      if (loungeChannel) {
        const announceEmbed = buildAcceptedAnnouncementEmbed(member, prospect);
        await loungeChannel.send({ embeds: [announceEmbed] }).catch((err) =>
          log.error({ err, prospectId: prospect.id }, 'Failed to send accepted announcement to lounge')
        );
      }
    }
  }

  const user = await guild.client.users.fetch(prospect.user_id).catch(() => null);
  if (user) {
    const messages = {
      accepted: '**[Prospect]** Congratulations! Your application to **Royal Battalion** has been **accepted**! Welcome to the team.',
      denied: reason
        ? `**[Prospect]** Your application to **Royal Battalion** has been **denied**.\n\n**Reason:** ${reason}\n\nThank you for your interest.`
        : '**[Prospect]** Your application to **Royal Battalion** has been **denied**. Thank you for your interest.',
      closed: '**[Prospect]** Your prospect application has been closed.',
    };
    await user.send(messages[outcome] || messages.closed).catch(() => null);
  }

  log.info({ prospectId: prospect.id, closedBy: closedById, outcome }, 'Prospect closed');
}

export async function togglePause(prospect, actorId, guild) {
  const isPaused = !!prospect.paused_at;

  if (isPaused) {
    const pausedMs = Date.now() - new Date(prospect.paused_at).getTime();
    const pausedDays = Math.ceil(pausedMs / (24 * 60 * 60 * 1000));
    await query(
      'UPDATE prospects SET paused_at = NULL, extra_days = COALESCE(extra_days, 0) + ? WHERE id = ?',
      [pausedDays, prospect.id]
    );
    await query(
      'INSERT INTO prospect_events (prospect_id, event_type, actor_id, detail) VALUES (?, ?, ?, ?)',
      [prospect.id, 'unpaused', actorId, `Paused for ${pausedDays} day(s)`]
    );
    log.info({ prospectId: prospect.id, pausedDays }, 'Prospect unpaused');
  } else {
    await query('UPDATE prospects SET paused_at = NOW() WHERE id = ?', [prospect.id]);
    await query(
      'INSERT INTO prospect_events (prospect_id, event_type, actor_id) VALUES (?, ?, ?)',
      [prospect.id, 'paused', actorId]
    );
    log.info({ prospectId: prospect.id }, 'Prospect paused');
  }

  await refreshStaffEmbed(prospect, guild);
  return { paused: !isPaused };
}

export async function extendProspect(prospect, days, actorId, guild) {
  await query(
    'UPDATE prospects SET extra_days = COALESCE(extra_days, 0) + ? WHERE id = ?',
    [days, prospect.id]
  );
  await query(
    'INSERT INTO prospect_events (prospect_id, event_type, actor_id, detail) VALUES (?, ?, ?, ?)',
    [prospect.id, 'extended', actorId, `+${days} day(s)`]
  );
  log.info({ prospectId: prospect.id, days }, 'Prospect extended');

  await refreshStaffEmbed(prospect, guild);
}

async function refreshStaffEmbed(prospect, guild) {
  const staffChannel = await guild.channels.fetch(prospect.channel_id).catch(() => null);
  if (!staffChannel) return;

  const updated = (await query('SELECT * FROM prospects WHERE id = ?', [prospect.id]))[0];
  const member = await guild.members.fetch(updated.user_id).catch(() => null);
  const forumUrl = updated.forum_thread_id
    ? `https://discord.com/channels/${guild.id}/${updated.forum_thread_id}`
    : null;
  const infoEmbed = buildProspectInfoEmbed(member, updated, forumUrl);
  const components = updated.forum_thread_id
    ? buildProspectAcceptedComponents(updated)
    : buildProspectComponents(updated);

  const topMsg = await findBotMessageByCustomId(staffChannel, guild.client.user.id, ['prospect_claim', 'prospect_accept', 'prospect_deny', 'prospect_pause']);
  if (topMsg) {
    await topMsg.edit({ embeds: [infoEmbed], components });
    appendCblToMessage(topMsg, updated.steam_id);
  }
}
