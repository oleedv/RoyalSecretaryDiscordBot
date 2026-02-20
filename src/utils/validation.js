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
  const dob = new Date(`${yyyy}-${mm}-${dd}`);
  const age = (Date.now() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000);

  if (isNaN(dob.getTime())) return '**Date of Birth**: invalid date.';
  if (age < 18) return '**Date of Birth**: you must be at least 18 years old.';

  return null;
}

/**
 * Validate squad hours input.
 * Returns an error string or null if valid.
 */
export function validateSquadHours(squadHours) {
  const hours = Number(squadHours);
  if (isNaN(hours) || hours <= 100) return '**Hours in Squad**: must be greater than 100.';
  return null;
}
