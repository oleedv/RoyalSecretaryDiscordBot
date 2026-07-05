import { createScheduler } from '../../utils/scheduler.js';
import config from '../../config.js';
import logger from '../../logger.js';
import { reportError } from '../admin/errorAlertService.js';
import {
  getBirthdayConfig,
  getEligibleBirthdayMembers,
  loadPostedToday,
  recordPosted,
  isConfigured,
} from './birthdayService.js';
import { buildBirthdayEmbed } from './birthdayEmbeds.js';
import {
  birthdayTargets,
  isEligibleBirthday,
  computeAge,
  localDateString,
  localTimeString,
} from './birthdayLogic.js';

const log = logger.child({ module: 'birthdayScheduler' });

// Reuse the shared ~60s cadence knob (settings.{env}.js seeding.schedulerCheckMs).
const CHECK_MS = config.seeding?.schedulerCheckMs || 60000;

const scheduler = createScheduler({
  name: 'birthdayDailyCheck',
  intervalMs: CHECK_MS,
  tick: checkBirthdays,
});

export function isSchedulerActive() {
  return scheduler.isActive();
}

export function startScheduler(client) {
  log.info('Starting birthday scheduler');
  scheduler.start(client);
}

export function stopScheduler() {
  scheduler.stop();
}

async function checkBirthdays(client) {
  // The webpage `website` pool is optional; if it's not wired in this environment,
  // config + eligibility both live there, so the feature is inert. Guard silently.
  if (!isConfigured()) return;

  const cfg = await getBirthdayConfig();
  if (!cfg || !cfg.enabled || !cfg.channelId) return;

  const tz = cfg.timezone || 'Europe/Oslo';
  const now = new Date();
  const postTime = cfg.postTime || '09:00';
  if (localTimeString(now, tz) < postTime) return; // not yet time today (tz-correct)

  const postDate = localDateString(now, tz);

  // Who already got a post today. On a read error, skip this tick (avoid double-post).
  const posted = await loadPostedToday(postDate);
  if (posted === null) return;

  const targets = birthdayTargets(now, tz);
  const members = await getEligibleBirthdayMembers(targets);
  const remaining = members.filter((m) => !posted.has(String(m.discordId)));
  if (remaining.length === 0) return;

  // Resolve the guild from the configured channel (one fetch yields both).
  const channel = await client.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel || !channel.guild) {
    log.warn({ channelId: cfg.channelId }, 'Birthday channel not found or not in a guild');
    return;
  }
  const guild = channel.guild;
  const memberRoleId = config.prospects?.memberRoleId;

  for (const row of remaining) {
    try {
      // Belt-and-suspenders: re-check the tested predicate against the SQL-provided
      // Y/M/D so the authoritative logic (and its unit tests) gate every post.
      const dob = new Date(Date.UTC(row.dobYear, row.dobMonth - 1, row.dobDay));
      if (!isEligibleBirthday(dob, now, tz)) continue;

      // Skip members who have left the guild — no dead ping. Not logged, so a
      // same-day rejoin can still be celebrated.
      const guildMember = await guild.members.fetch(String(row.discordId)).catch(() => null);
      if (!guildMember) continue;

      const showAge = !!row.birthdayShowAge;
      const age = showAge ? computeAge(row.dobYear, now, tz) : null;
      const avatarUrl = guildMember.displayAvatarURL({ size: 256 }) || row.avatarUrl || null;
      const displayName = guildMember.displayName || row.displayName || row.discordName;

      const embed = buildBirthdayEmbed({ displayName, avatarUrl, showAge, age });

      const mentions = [`<@${row.discordId}>`];
      const allowedRoles = [];
      if (memberRoleId) {
        mentions.push(`<@&${memberRoleId}>`);
        allowedRoles.push(String(memberRoleId));
      }

      await channel.send({
        content: mentions.join(' '),
        embeds: [embed],
        allowedMentions: { users: [String(row.discordId)], roles: allowedRoles },
      });

      // Record only after a successful send: safe against double-posts AND a
      // mid-batch restart (a crash after N sends resumes with the remaining members).
      await recordPosted(String(row.discordId), postDate);
      log.info({ discordId: row.discordId, postDate }, 'Posted birthday announcement');
    } catch (err) {
      // Send/DB failures are logged, not thrown — the batch continues (existing convention).
      log.error({ err, discordId: row.discordId }, 'Failed to post birthday announcement');
      reportError(err, { source: 'scheduler:birthday:post' }).catch(() => {});
    }
  }
}
