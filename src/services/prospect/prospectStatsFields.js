// Classification + ordering for the prospect stats embed fields.
// Field names carry dynamic suffixes (e.g. "Game Activity (14d in)"),
// so fields are identified by stable PREFIX, not exact name.

const ACTIVITY_PREFIXES = ['Game Activity', 'Seeding', 'Discord Activity'];
const CHECK_PREFIXES = [
  'Community Ban List',
  'BattleMetrics Bans',
  'BattleMetrics Flags',
  'BattleMetrics Staff Notes',
  'Steam Bans',
];
const LAST_UPDATED_PREFIX = 'Last updated';

export function classifyStatField(name) {
  if (!name) return null;
  if (name.startsWith(LAST_UPDATED_PREFIX)) return 'lastUpdated';
  if (ACTIVITY_PREFIXES.some((p) => name.startsWith(p))) return 'activity';
  if (CHECK_PREFIXES.some((p) => name.startsWith(p))) return 'check';
  return null;
}

// Reassemble fields in canonical order: [app] [activity] [checks] [Last updated].
// Pass newActivity / newChecks / newLastUpdated (arrays) to REPLACE that group;
// pass null/undefined to KEEP whatever is already present in existingFields.
export function buildOrderedStatFields(existingFields, { newActivity = null, newChecks = null, newLastUpdated = null } = {}) {
  const fields = existingFields || [];
  const appFields = fields.filter((f) => classifyStatField(f.name) === null);
  const activity = newActivity ?? fields.filter((f) => classifyStatField(f.name) === 'activity');
  const checks = newChecks ?? fields.filter((f) => classifyStatField(f.name) === 'check');
  const lastUpdated = newLastUpdated ?? fields.filter((f) => classifyStatField(f.name) === 'lastUpdated');
  return [...appFields, ...activity, ...checks, ...lastUpdated];
}
