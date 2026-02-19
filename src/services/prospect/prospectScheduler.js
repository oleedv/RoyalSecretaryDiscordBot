import { getProspectsNeedingVote } from './prospectService.js';
import { postVote } from './prospectVoting.js';
import logger from '../../logger.js';

const log = logger.child({ module: 'prospectScheduler' });

let intervalId = null;

export function startScheduler(client) {
  if (intervalId) {
    log.warn('Scheduler already running — skipping double start');
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
