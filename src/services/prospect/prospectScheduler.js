import { getProspectsNeedingVote } from './prospectService.js';
import { postVote } from './prospectVoting.js';
import { getPlaytime } from '../playtimeService.js';
import { createEmbed } from '../../utils/embed.js';
import config from '../../config.js';
import logger from '../../logger.js';

const log = logger.child({ module: 'prospectScheduler' });

let intervalId = null;

export function startScheduler(client) {
  if (intervalId) {
    log.warn('Scheduler already running - skipping double start');
    return;
  }

  log.info('Starting prospect vote scheduler (1h interval)');

  runVoteCheck(client);
  intervalId = setInterval(() => runVoteCheck(client), 60 * 60 * 1000);
}

async function runVoteCheck(client) {
  try {
    const prospects = await getProspectsNeedingVote();
    if (prospects.length === 0) return;

    log.info(`Found ${prospects.length} prospect(s) needing vote`);

    for (const prospect of prospects) {
      try {
        if (prospect.steam_id && prospect.steam_id.toUpperCase() !== 'Q') {
          const stats = await getPlaytime(prospect.steam_id, prospect.created_at).catch(() => null);
          if (stats && stats.playtimeHours < 16) {
            log.info({ prospectId: prospect.id, playtimeHours: stats.playtimeHours }, 'Skipping vote - prospect has < 16h playtime');

            const { periodDays } = config.prospects;
            const extra = prospect.extra_days || 0;
            const endDate = new Date(prospect.created_at);
            endDate.setDate(endDate.getDate() + periodDays + extra);

            if (new Date() >= endDate) {
              const guild = await client.guilds.fetch(config.guild.id).catch(() => null);
              const staffChannel = guild ? await guild.channels.fetch(prospect.channel_id).catch(() => null) : null;
              if (staffChannel) {
                const warnEmbed = createEmbed('Prospect')
                  .setTitle('Insufficient Playtime')
                  .setDescription(
                    `**${prospect.alias}**'s prospect period has ended but they only have **${stats.playtimeHours}h** of playtime (16h required).\n` +
                    'The vote will be posted automatically once they reach 16 hours, or a staff member can force-vote from the ticket.'
                  )
                  .setColor(0xed4245);
                await staffChannel.send({ embeds: [warnEmbed] }).catch(() => null);
              }
            }
            continue;
          }
        }
        await postVote(prospect, client);
      } catch (err) {
        log.error({ err, prospectId: prospect.id }, 'Failed to post vote for prospect');
      }
    }
  } catch (err) {
    log.error({ err }, 'Vote check failed');
  }
}

export function stopScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('Prospect vote scheduler stopped');
  }
}
