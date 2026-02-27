/**
 * Validate a date-of-birth string in DD-MM-YYYY or DD/MM/YYYY format.
 * Returns an error string or null if valid.
 */
export function validateDateOfBirth(dateOfBirth) {
  const dobMatch = dateOfBirth.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  if (!dobMatch) {
    return '**Date of Birth**: must be DD-MM-YYYY or DD/MM/YYYY.';
  }

  const [, dd, mm, yyyy] = dobMatch;
  const day = parseInt(dd, 10);
  const month = parseInt(mm, 10);
  const year = parseInt(yyyy, 10);

  const dob = new Date(Date.UTC(year, month - 1, day));
  if (isNaN(dob.getTime()) || dob.getUTCDate() !== day || dob.getUTCMonth() !== month - 1) {
    return '**Date of Birth**: invalid date.';
  }

  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < dob.getUTCDate())) {
    age--;
  }

  if (age < 18) return '**Date of Birth**: you must be at least 18 years old.';
  if (age > 120) return '**Date of Birth**: invalid date.';

  return null;
}

/**
 * Validate squad hours input.
 * Returns an error string or null if valid.
 */
export function validateSquadHours(squadHours) {
  if (!/^\d+$/.test(squadHours)) return '**Hours in Squad**: must be a whole number.';
  const hours = parseInt(squadHours, 10);
  if (hours <= 100) return '**Hours in Squad**: must be greater than 100.';
  if (hours > 50000) return '**Hours in Squad**: value seems unrealistic (max 50,000).';
  return null;
}
