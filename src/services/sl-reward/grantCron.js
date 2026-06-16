import { query } from '../../database/connection.js';
import logger from '../../logger.js';
import { createScheduler } from '../../utils/scheduler.js';
import { createSlEntry, extendEntryByDays, findEntries, isConfigured } from '../whitelistService.js';
import { decideRewardAction } from './eligibility.js';
import { flushPendingDms, sendOrQueueDm } from './dmQueue.js';
import { hypercareLog } from './hypercareLog.js';
import {
  SL_CLAN_ID,
  SL_DRY_RUN,
  SL_EXTEND_WHEN_REMAINING_HOURS,
  SL_GRANT_INTERVAL_MS,
  SL_REWARD_DAYS,
  SL_THRESHOLD_HOURS
} from './constants.js';

const log = logger.child({ module: 'sl-reward-grant' });

const GRANT_DM =
  "Thanks for squadleading! You've earned 7 days of free whitelist on the Main server. Enjoy, and keep leading.";

// Players with >= threshold qualifying SL hours in the rolling 7-day window.
async function getCandidates() {
  return query(
    `SELECT p.id AS playerId, p.steam_id AS steamId, p.name AS name,
            SUM(s.qualifying_sl_s) / 3600.0 AS hours
     FROM squadjs_sl_round_stats s
     JOIN squadjs_players p ON p.id = s.player_id
     WHERE s.created_at > NOW() - INTERVAL 7 DAY AND p.steam_id IS NOT NULL
     GROUP BY p.id
     HAVING SUM(s.qualifying_sl_s) >= ?`,
    [SL_THRESHOLD_HOURS * 3600],
    'squadjs'
  );
}

async function getWebUser(steamId) {
  try {
    const rows = await query('SELECT id, discordId FROM User WHERE steamId = ?', [steamId], 'website');
    return rows?.[0] ?? null;
  } catch (err) {
    log.warn({ err, steamId }, 'getWebUser failed');
    return null;
  }
}

async function tick(client) {
  if (!isConfigured()) {
    log.warn('website pool not configured; SL grant cron idle');
    return;
  }

  // First retry any grant DMs that couldn't be delivered on an earlier run.
  const flushed = await flushPendingDms(client);

  let candidates;
  try {
    candidates = await getCandidates();
  } catch (err) {
    log.error({ err }, 'candidate query failed');
    return;
  }

  let grants = 0;
  let extensions = 0;
  let dmsQueued = 0;
  const skips = {};

  for (const c of candidates) {
    const hours = Number(c.hours);
    const entries = await findEntries(c.steamId);
    const decision = decideRewardAction({
      rollingHours: hours,
      entries,
      slClanId: SL_CLAN_ID,
      thresholdHours: SL_THRESHOLD_HOURS,
      extendThresholdHours: SL_EXTEND_WHEN_REMAINING_HOURS
    });

    if (decision.action === 'skip') {
      skips[decision.reason] = (skips[decision.reason] ?? 0) + 1;
      continue;
    }

    if (decision.action === 'grant') {
      if (SL_DRY_RUN) {
        log.info({ steamId: c.steamId, hours }, 'DRY: would grant');
        await hypercareLog(client, {
          title: 'DRY — would grant',
          description: `**${c.name}** — ${hours.toFixed(1)}h → 7d whitelist`,
          color: 0x95a5a6,
          verboseOnly: true
        });
      } else {
        const webUser = await getWebUser(c.steamId);
        const entry = await createSlEntry(
          c.steamId,
          webUser?.id ?? null,
          c.name,
          SL_CLAN_ID,
          'sl-reward-system',
          'Earned via Squad Leader rewards (5h+ rolling 7d)',
          SL_REWARD_DAYS
        );
        if (!entry) {
          log.warn({ steamId: c.steamId }, 'grant insert returned null');
          continue;
        }
        log.info({ steamId: c.steamId, hours, entryId: entry.id }, 'granted SL whitelist');
        const delivered = await sendOrQueueDm(client, webUser?.discordId, GRANT_DM);
        if (!delivered && webUser?.discordId) dmsQueued++;
        await hypercareLog(client, {
          title: 'Granted SL whitelist',
          description: `**${c.name}** — ${hours.toFixed(1)}h → ${SL_REWARD_DAYS}d (steam \`${c.steamId}\`)`,
          color: 0x2ecc71,
          verboseOnly: true
        });
      }
      grants++;
      continue;
    }

    if (decision.action === 'extend') {
      if (SL_DRY_RUN) {
        log.info({ steamId: c.steamId, entryId: decision.slEntry.id }, 'DRY: would extend');
        await hypercareLog(client, {
          title: 'DRY — would extend',
          description: `**${c.name}** — ${hours.toFixed(1)}h, +${SL_REWARD_DAYS}d`,
          color: 0x95a5a6,
          verboseOnly: true
        });
      } else {
        const ok = await extendEntryByDays(decision.slEntry.id, SL_REWARD_DAYS);
        if (!ok) {
          log.warn({ steamId: c.steamId, entryId: decision.slEntry.id }, 'extend failed');
          continue;
        }
        log.info({ steamId: c.steamId, entryId: decision.slEntry.id }, 'extended SL whitelist');
        await hypercareLog(client, {
          title: 'Extended SL whitelist',
          description: `**${c.name}** — ${hours.toFixed(1)}h, +${SL_REWARD_DAYS}d`,
          color: 0x3498db,
          verboseOnly: true
        });
      }
      extensions++;
    }
  }

  const dmNote =
    dmsQueued || flushed.sent ? ` · DMs queued ${dmsQueued} · redelivered ${flushed.sent}` : '';
  const summary = `candidates ${candidates.length} · grants ${grants} · extensions ${extensions} · skips ${JSON.stringify(
    skips
  )}${dmNote}${SL_DRY_RUN ? ' · DRY-RUN' : ''}`;
  log.info(
    { candidates: candidates.length, grants, extensions, skips, dmsQueued, dmsRedelivered: flushed.sent, dry: SL_DRY_RUN },
    'sl-reward cron complete'
  );
  await hypercareLog(client, {
    title: 'SL grant cron run',
    description: summary,
    color: grants || extensions ? 0x2ecc71 : 0x3498db,
    // After hypercare (verbose off) only surface runs that actually did something,
    // so the channel isn't pinged every 30 min for a no-op run.
    verboseOnly: !(grants || extensions)
  });
}

const scheduler = createScheduler({
  name: 'slRewardGrantScheduler',
  intervalMs: SL_GRANT_INTERVAL_MS,
  tick
});

export function startScheduler(client) {
  scheduler.start(client);
}
export function stopScheduler() {
  scheduler.stop();
}
