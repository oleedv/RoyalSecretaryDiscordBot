import { getProspectsNeedingVote, getProspectsNeedingVoteEnd, isTestSteamId, getProspectDates, refreshAllOpenProspectStats, refreshAllOpenProspectChecks } from './prospectService.js';
import { postVote, finalizeVote } from './prospectVoting.js';
import { shouldSkipVoteStart } from './prospectVoteRules.js';
import { getProspectConfig } from './prospectConfig.js';
import { getPlaytime } from '../playtimeService.js';
import { createEmbed } from '../../utils/embed.js';
import config from '../../config.js';
import logger from '../../logger.js';
import { reportError } from '../admin/errorAlertService.js';

const log = logger.child({ module: 'prospectScheduler' });

let intervalId = null;
let isRunning = false;
let isRefreshing = false;
let isEndingVote = false;

/** Track prospect IDs that have already been warned about low playtime */
const lowPlaytimeWarned = new Set();

export function startScheduler(client) {
  if (intervalId) {
    log.warn('Scheduler already running - skipping double start');
    return;
  }

  log.info('Starting prospect scheduler (1h interval: vote check + stats refresh)');

  tick(client);
  intervalId = setInterval(() => tick(client), 60 * 60 * 1000);
}

function tick(client) {
  runVoteCheck(client);
  runVoteEndCheck(client);
  runStatsRefresh(client);
}

async function runStatsRefresh(client) {
  if (isRefreshing) {
    log.warn('Stats refresh still running from previous tick, skipping');
    return;
  }
  isRefreshing = true;
  try {
    await refreshAllOpenProspectStats(client);
    const CHECKS_REFRESH_UTC_HOUR = 3;
    if (new Date().getUTCHours() === CHECKS_REFRESH_UTC_HOUR) {
      await refreshAllOpenProspectChecks(client);
    }
  } catch (err) {
    log.error({ err }, 'Stats refresh failed');
    reportError(err, { source: 'scheduler:prospect:statsRefresh' }).catch(() => {});
  } finally {
    isRefreshing = false;
  }
}

async function runVoteCheck(client) {
  if (isRunning) {
    log.warn('Vote check still running from previous tick, skipping');
    return;
  }
  isRunning = true;
  try {
    const prospects = await getProspectsNeedingVote();
    if (prospects.length === 0) return;

    log.info(`Found ${prospects.length} prospect(s) needing vote`);

    for (const prospect of prospects) {
      try {
        if (!isTestSteamId(prospect.steam_id)) {
          const stats = await getPlaytime(prospect.steam_id, prospect.period_started_at || prospect.created_at).catch(() => null);
          const live = await getProspectConfig();
          const startHours = live.voteStartHours;
          if (shouldSkipVoteStart(stats?.playtimeHours ?? null, startHours)) {
            log.info({ prospectId: prospect.id, playtimeHours: stats.playtimeHours }, 'Skipping vote - below start hours');

            const { periodEnd } = getProspectDates(prospect, live.periodDays);

            if (new Date() >= periodEnd && !lowPlaytimeWarned.has(prospect.id)) {
              lowPlaytimeWarned.add(prospect.id);
              const guild = await client.guilds.fetch(config.guild.id).catch(() => null);
              const staffChannel = guild ? await guild.channels.fetch(prospect.channel_id).catch(() => null) : null;
              if (staffChannel) {
                const warnEmbed = createEmbed('Prospect')
                  .setTitle('Insufficient Playtime')
                  .setDescription(
                    `**${prospect.alias}**'s prospect period has ended but they only have **${stats.playtimeHours}h** of playtime (${startHours}h required to start the vote).\n` +
                    `The vote will be posted automatically once they reach ${startHours} hours, or a staff member can force-vote from the ticket.`
                  )
                  .setColor(0xed4245);
                await staffChannel.send({ embeds: [warnEmbed] }).catch(() => null);
              }
            }
            continue;
          } else {
            // Playtime threshold met - clear any previous warning tracking
            lowPlaytimeWarned.delete(prospect.id);
          }
        }
        await postVote(prospect, client);
      } catch (err) {
        log.error({ err, prospectId: prospect.id }, 'Failed to post vote for prospect');
        reportError(err, { source: 'scheduler:prospect:postVote' }).catch(() => {});
      }
    }
  } catch (err) {
    log.error({ err }, 'Vote check failed');
    reportError(err, { source: 'scheduler:prospect:voteCheck' }).catch(() => {});
  } finally {
    isRunning = false;
  }
}

async function runVoteEndCheck(client) {
  if (isEndingVote) {
    log.warn('Vote-end check still running from previous tick, skipping');
    return;
  }
  isEndingVote = true;
  try {
    const prospects = await getProspectsNeedingVoteEnd();
    if (prospects.length === 0) return;

    log.info(`Found ${prospects.length} prospect(s) with vote period ended`);

    const guild = await client.guilds.fetch(config.guild.id).catch(() => null);
    if (!guild) {
      log.warn('Vote-end check: guild fetch failed, skipping');
      return;
    }

    for (const prospect of prospects) {
      try {
        await finalizeVote(prospect, client.user.id, client, guild);
      } catch (err) {
        log.error({ err, prospectId: prospect.id }, 'Failed to auto-finalize vote');
        reportError(err, { source: 'scheduler:prospect:finalizeVote' }).catch(() => {});
      }
    }
  } catch (err) {
    log.error({ err }, 'Vote-end check failed');
    reportError(err, { source: 'scheduler:prospect:voteEndCheck' }).catch(() => {});
  } finally {
    isEndingVote = false;
  }
}

export function isSchedulerActive() {
  return intervalId !== null;
}

export function stopScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('Prospect vote scheduler stopped');
  }
}
