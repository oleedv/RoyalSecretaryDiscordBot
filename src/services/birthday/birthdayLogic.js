// Pure date helpers for the birthday announcer. No Discord/DB imports, so the
// eligibility logic is unit-testable in isolation.

// {year, month, day} of `now` in the given IANA timezone.
export function localYmd(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (t) => parseInt(parts.find((p) => p.type === t)?.value ?? '0', 10);
  return { year: get('year'), month: get('month'), day: get('day') };
}

// 'YYYY-MM-DD' for `now` in `timezone` (matches the post_date DATE column).
export function localDateString(now, timezone) {
  const { year, month, day } = localYmd(now, timezone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// 'HH:MM' (24h) for `now` in `timezone`.
export function localTimeString(now, timezone) {
  try {
    const hour = parseInt(
      new Intl.DateTimeFormat('en', { hour: '2-digit', hour12: false, timeZone: timezone }).format(now),
      10,
    );
    const minute = parseInt(
      new Intl.DateTimeFormat('en', { minute: '2-digit', timeZone: timezone }).format(now),
      10,
    );
    return `${String(hour % 24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  } catch {
    return `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  }
}

export function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

// Month/day pairs that count as "today's birthday" in `timezone`. Normally just
// today; on Feb 28 of a common (non-leap) year, Feb 29 birthdays are celebrated
// too, so (2,29) is added.
export function birthdayTargets(now, timezone) {
  const { year, month, day } = localYmd(now, timezone);
  const targets = [{ month, day }];
  if (month === 2 && day === 28 && !isLeapYear(year)) {
    targets.push({ month: 2, day: 29 });
  }
  return targets;
}

// True when `dob` (Date|string|null) is a real birthday matching today in
// `timezone`. Excludes null and the Jan-1 placeholder. Month/day are read via UTC
// components, so callers must build the Date from UTC parts (Date.UTC(...)) to
// stay timezone-agnostic.
export function isEligibleBirthday(dob, now, timezone) {
  if (!dob) return false;
  const d = dob instanceof Date ? dob : new Date(dob);
  if (Number.isNaN(d.getTime())) return false;
  const bMonth = d.getUTCMonth() + 1;
  const bDay = d.getUTCDate();
  if (bMonth === 1 && bDay === 1) return false; // placeholder DOB
  return birthdayTargets(now, timezone).some((t) => t.month === bMonth && t.day === bDay);
}

// Age reached on the celebrated day: today's local year minus the birth year.
// Correct for both a normal birthday and a Feb-29 birthday celebrated on Feb 28.
export function computeAge(dobYear, now, timezone) {
  return localYmd(now, timezone).year - dobYear;
}
