import { DateTime, IANAZone } from 'luxon';

/**
 * Parse a human-entered time of day in either 24-hour (`18:00`) or 12-hour
 * (`6:00 PM`, `6 pm`) form. Returns `{ hour, minute }` (24-hour) or `null` if
 * the string can't be understood.
 */
export function parseTimeOfDay(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase().replace(/\s+/g, '');
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/);
  if (!m) return null;

  let hour = parseInt(m[1], 10);
  const minute = m[2] !== undefined ? parseInt(m[2], 10) : 0;
  const meridiem = m[3];

  if (minute > 59) return null;

  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'pm' && hour !== 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
  } else if (hour > 23) {
    return null;
  }

  return { hour, minute };
}

/** True if `zone` is a timezone the runtime recognises (e.g. 'Europe/Oslo'). */
export function isValidZone(zone) {
  return IANAZone.isValidZone(zone);
}

/**
 * Convert a local wall-clock date + time in a given IANA timezone to a Unix
 * epoch (seconds), DST-aware. Returns `{ unix }` on success or `{ error }`
 * with one of: 'invalid_zone' | 'invalid_date' | 'invalid_time'.
 */
export function unixFromLocal(dateStr, timeStr, zone) {
  if (!IANAZone.isValidZone(zone)) return { error: 'invalid_zone' };

  const dateMatch = typeof dateStr === 'string' && dateStr.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateMatch) return { error: 'invalid_date' };

  const time = parseTimeOfDay(timeStr);
  if (!time) return { error: 'invalid_time' };

  const dt = DateTime.fromObject(
    {
      year: Number(dateMatch[1]),
      month: Number(dateMatch[2]),
      day: Number(dateMatch[3]),
      hour: time.hour,
      minute: time.minute,
    },
    { zone }
  );

  if (!dt.isValid) return { error: 'invalid_date' };

  return { unix: Math.floor(dt.toSeconds()) };
}
