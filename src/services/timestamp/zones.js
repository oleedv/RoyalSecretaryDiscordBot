import { DateTime } from 'luxon';

const MAX_SUGGESTIONS = 25;

// Shown (saved zone first) when the user hasn't typed anything yet.
export const COMMON_ZONES = [
  'Europe/Oslo',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Moscow',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
  'UTC',
];

/** All IANA zones the runtime knows about. */
export function listZones() {
  return typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
}

/**
 * Filter a list of IANA zones for autocomplete. Empty input yields the common
 * list (with the saved zone hoisted to the front); otherwise a case-insensitive
 * substring match against the id (underscores treated as spaces). A matching
 * saved zone is moved to the front. Capped at Discord's 25-choice limit.
 */
export function filterZones(allZones, input, { savedZone, common = COMMON_ZONES } = {}) {
  const q = (input ?? '').trim().toLowerCase();
  const present = new Set(allZones);

  let result;
  if (!q) {
    result = [savedZone, ...common].filter((z) => z && present.has(z));
  } else {
    result = allZones.filter((z) => {
      const id = z.toLowerCase();
      return id.includes(q) || id.replace(/_/g, ' ').includes(q);
    });
    if (savedZone && result.includes(savedZone)) {
      result = [savedZone, ...result.filter((z) => z !== savedZone)];
    }
  }

  // De-duplicate, preserving order, and cap.
  return [...new Set(result)].slice(0, MAX_SUGGESTIONS);
}

/**
 * Build Discord autocomplete choices ({ name, value }) for the typed input,
 * annotating each zone with its current local time. Not unit-tested (depends
 * on the wall clock); the filtering brain (filterZones) is.
 */
export function suggestZones(input, savedZone) {
  return filterZones(listZones(), input, { savedZone }).map((zone) => {
    const now = DateTime.now().setZone(zone);
    const label = now.isValid ? `${zone} (${now.toFormat('HH:mm')})` : zone;
    return { name: label.slice(0, 100), value: zone };
  });
}
