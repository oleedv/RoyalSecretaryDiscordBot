import { test, expect } from 'bun:test';
import {
  isLeapYear,
  birthdayTargets,
  isEligibleBirthday,
  computeAge,
  localDateString,
  localTimeString,
} from './birthdayLogic.js';

const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const TZ = 'UTC';

test('isLeapYear', () => {
  expect(isLeapYear(2024)).toBe(true);
  expect(isLeapYear(2026)).toBe(false);
  expect(isLeapYear(2000)).toBe(true);
  expect(isLeapYear(1900)).toBe(false);
});

test('null and invalid DOB are ineligible', () => {
  expect(isEligibleBirthday(null, utc(2026, 5, 15), TZ)).toBe(false);
  expect(isEligibleBirthday('not-a-date', utc(2026, 5, 15), TZ)).toBe(false);
});

test('Jan-1 placeholder is excluded even when today is Jan 1', () => {
  expect(isEligibleBirthday(utc(1990, 1, 1), utc(2026, 1, 1), TZ)).toBe(false);
});

test('matching month/day is eligible; non-matching is not', () => {
  expect(isEligibleBirthday(utc(1990, 5, 15), utc(2026, 5, 15), TZ)).toBe(true);
  expect(isEligibleBirthday(utc(1990, 5, 16), utc(2026, 5, 15), TZ)).toBe(false);
});

test('Feb-29 birthday celebrated on Feb 28 in a common year', () => {
  expect(isEligibleBirthday(utc(2000, 2, 29), utc(2026, 2, 28), TZ)).toBe(true);
});

test('Feb-29 birthday NOT celebrated on Feb 28 in a leap year', () => {
  expect(isEligibleBirthday(utc(2000, 2, 29), utc(2028, 2, 28), TZ)).toBe(false);
  expect(isEligibleBirthday(utc(2000, 2, 29), utc(2028, 2, 29), TZ)).toBe(true);
});

test('birthdayTargets adds Feb-29 only on common-year Feb 28', () => {
  expect(birthdayTargets(utc(2026, 2, 28), TZ)).toEqual([{ month: 2, day: 28 }, { month: 2, day: 29 }]);
  expect(birthdayTargets(utc(2028, 2, 28), TZ)).toEqual([{ month: 2, day: 28 }]);
  expect(birthdayTargets(utc(2026, 5, 15), TZ)).toEqual([{ month: 5, day: 15 }]);
});

test('computeAge = local year minus birth year', () => {
  expect(computeAge(1990, utc(2026, 5, 15), TZ)).toBe(36);
  expect(computeAge(2000, utc(2026, 2, 28), TZ)).toBe(26);
});

test('localDateString / localTimeString', () => {
  expect(localDateString(new Date('2026-07-05T09:30:00Z'), 'UTC')).toBe('2026-07-05');
  expect(localTimeString(new Date('2026-07-05T09:30:00Z'), 'UTC')).toBe('09:30');
});
