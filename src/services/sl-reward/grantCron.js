import { AttachmentBuilder } from 'discord.js';
import { query } from '../../database/connection.js';
import logger from '../../logger.js';
import { createScheduler } from '../../utils/scheduler.js';
import { createSlEntry, extendEntryByDays, findEntries, isConfigured } from '../whitelistService.js';
import { decideRewardAction } from './eligibility.js';
import { flushPendingDms, sendOrQueueDm } from './dmQueue.js';
import { buildExtendLogEmbed, buildGrantLogEmbed, buildRunSummaryEmbed } from './embeds.js';
import { buildCandidateReport } from './report.js';
import { hypercareSend } from './hypercareLog.js';
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
  const rows = [];

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

    // One report row per candidate, reflecting the decision; discordId is filled in
    // below for grant/extend (skips don't resolve a web user).
    const row = { name: c.name, steamId: c.steamId, hours, action: decision.action, reason: decision.reason, discordId: null };
    rows.push(row);

    if (decision.action === 'skip') {
      skips[decision.reason] = (skips[decision.reason] ?? 0) + 1;
      continue;
    }

    const webUser = await getWebUser(c.steamId);
    row.discordId = webUser?.discordId ?? null;

    if (decision.action === 'grant') {
      const expiresAt = new Date(Date.now() + SL_REWARD_DAYS * 86400000);
      if (SL_DRY_RUN) {
        log.info({ steamId: c.steamId, hours }, 'DRY: would grant');
      } else {
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
      }
      await hypercareSend(
        client,
        buildGrantLogEmbed({
          name: c.name,
          steamId: c.steamId,
          discordId: webUser?.discordId,
          hours,
          days: SL_REWARD_DAYS,
          expiresAt,
          dry: SL_DRY_RUN
        }),
        { verboseOnly: true }
      );
      grants++;
      continue;
    }

    if (decision.action === 'extend') {
      if (SL_DRY_RUN) {
        log.info({ steamId: c.steamId, entryId: decision.slEntry.id }, 'DRY: would extend');
      } else {
        const ok = await extendEntryByDays(decision.slEntry.id, SL_REWARD_DAYS);
        if (!ok) {
          log.warn({ steamId: c.steamId, entryId: decision.slEntry.id }, 'extend failed');
          continue;
        }
        log.info({ steamId: c.steamId, entryId: decision.slEntry.id }, 'extended SL whitelist');
      }
      await hypercareSend(
        client,
        buildExtendLogEmbed({
          name: c.name,
          steamId: c.steamId,
          discordId: webUser?.discordId,
          hours,
          days: SL_REWARD_DAYS,
          dry: SL_DRY_RUN
        }),
        { verboseOnly: true }
      );
      extensions++;
    }
  }

  log.info(
    { candidates: candidates.length, grants, extensions, skips, dmsQueued, dmsRedelivered: flushed.sent, dry: SL_DRY_RUN },
    'sl-reward cron complete'
  );

  // Only post a run summary when the run actually did something (a grant, extension,
  // or DM that was queued/redelivered) — no-op runs stay silent so the channel isn't
  // pinged every interval. Posts carry the full candidate list as a .txt attachment.
  const activity = grants || extensions || dmsQueued || flushed.sent;
  if (!activity) return;

  const nowIso = new Date().toISOString();
  const report = buildCandidateReport(rows, {
    nowIso,
    env: process.env.NODE_ENV ?? 'development',
    dry: SL_DRY_RUN,
    thresholdHours: SL_THRESHOLD_HOURS,
    rewardDays: SL_REWARD_DAYS,
    candidates: candidates.length,
    grants,
    extensions,
    skipped: Object.values(skips).reduce((a, b) => a + b, 0),
    dmsQueued,
    dmsRedelivered: flushed.sent
  });
  const file = new AttachmentBuilder(Buffer.from(report, 'utf8'), {
    name: `sl-grant-run-${nowIso.slice(0, 16).replace(/[:T]/g, '-')}.txt`
  });

  await hypercareSend(
    client,
    buildRunSummaryEmbed({
      candidates: candidates.length,
      grants,
      extensions,
      skips,
      dmsQueued,
      dmsRedelivered: flushed.sent,
      dry: SL_DRY_RUN
    }),
    { files: [file] }
  );
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
