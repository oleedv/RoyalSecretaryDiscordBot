// Pure builder for the staff-facing SL grant cron report (.txt attachment).
// No I/O so it stays trivially testable; the cron supplies the candidate rows + run meta.

const ACTION_ORDER = { grant: 0, extend: 1, skip: 2 };

function fmtUtc(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function col(value, width) {
  const s = String(value ?? '');
  return s.length >= width ? `${s.slice(0, width - 1)} ` : s.padEnd(width);
}

/**
 * Build the plain-text candidate report.
 * @param {Array<{name,steamId,hours,action,reason,discordId}>} rows
 * @param {{nowIso,env,dry,thresholdHours,rewardDays,candidates,grants,extensions,skipped,dmsQueued,dmsRedelivered}} meta
 * @returns {string}
 */
export function buildCandidateReport(rows, meta) {
  const sorted = [...rows].sort((a, b) => {
    const byAction = (ACTION_ORDER[a.action] ?? 9) - (ACTION_ORDER[b.action] ?? 9);
    return byAction !== 0 ? byAction : Number(b.hours) - Number(a.hours);
  });

  const header = [
    `SL Grant Cron Run — ${fmtUtc(meta.nowIso)}`,
    `Environment: ${meta.env} | Dry-run: ${meta.dry ? 'yes' : 'no'}`,
    `Threshold: ${Number(meta.thresholdHours).toFixed(1)}h rolling 7d | Reward: ${meta.rewardDays} days`,
    `Candidates: ${meta.candidates} | Granted: ${meta.grants} | Extended: ${meta.extensions} | Skipped: ${meta.skipped} | DMs: queued ${meta.dmsQueued} · redelivered ${meta.dmsRedelivered}`,
    '-'.repeat(60),
    col('NAME', 18) + col('HOURS', 7) + col('ACTION', 8) + col('REASON', 20) + col('STEAM', 19) + 'DISCORD'
  ];

  const body = sorted.length
    ? sorted.map((r) =>
        col(r.name || 'Unknown', 18) +
        col(Number(r.hours).toFixed(1), 7) +
        col(String(r.action).toUpperCase(), 8) +
        col(r.reason || '', 20) +
        col(r.steamId || '', 19) +
        (r.discordId || '-')
      )
    : ['(none)'];

  return [...header, ...body].join('\n') + '\n';
}
