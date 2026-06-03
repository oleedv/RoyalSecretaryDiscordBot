export function pickWinner(entries, rng = Math.random) {
  const eligible = entries.filter((e) => e.tickets > 0);
  if (eligible.length === 0) return null;

  const total = eligible.reduce((sum, e) => sum + e.tickets, 0);
  const roll = rng() * total;

  let cum = 0;
  for (const entry of eligible) {
    cum += entry.tickets;
    if (cum >= roll) return entry;
  }
  // Fallback for floating-point edge (roll === total).
  return eligible[eligible.length - 1];
}
