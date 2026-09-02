export function computeTickets(entry, live, votes, weights) {
  const hours = entry.manualHours != null ? Number(entry.manualHours) : Number(live?.playtimeHours ?? 0);
  const seed  = entry.manualSeed  != null ? Number(entry.manualSeed)  : Number(live?.seedHours ?? 0);
  const raw = hours * weights.hours + seed * weights.seed + votes * weights.vote;
  const earned = Math.floor(raw);
  const bonus = Number(entry.bonusTickets ?? 0);
  const extra = Number.isFinite(bonus) ? Math.trunc(bonus) : 0;
  return Math.max(0, earned + extra);
}
