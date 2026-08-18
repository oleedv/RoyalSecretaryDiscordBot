import { describe, it, expect } from 'bun:test';
import {
  shouldSkipVoteStart,
  shouldShowHoursWarning,
  hoursWarningValue,
  formatOffDiscordCount,
  evaluateVoteOutcome,
} from '../prospectVoteRules.js';

describe('shouldSkipVoteStart', () => {
  it('skips only when hours are a number below the start gate', () => {
    expect(shouldSkipVoteStart(5.9, 6)).toBe(true);
    expect(shouldSkipVoteStart(6, 6)).toBe(false);
    expect(shouldSkipVoteStart(16, 6)).toBe(false);
    expect(shouldSkipVoteStart(null, 6)).toBe(false);
    expect(shouldSkipVoteStart(undefined, 6)).toBe(false);
  });
});

describe('shouldShowHoursWarning', () => {
  it('shows the warning only when hours are known and below accept', () => {
    expect(shouldShowHoursWarning(8.4, 16)).toBe(true);
    expect(shouldShowHoursWarning(16, 16)).toBe(false);
    expect(shouldShowHoursWarning(null, 16)).toBe(false);
  });
});

describe('copy helpers', () => {
  it('embeds the accept threshold in the warning', () => {
    expect(hoursWarningValue(16)).toContain('16 hours');
    expect(hoursWarningValue(16)).toContain('cannot be accepted');
  });
  it('pluralises the off-discord count', () => {
    expect(formatOffDiscordCount(0)).toBe('0 times');
    expect(formatOffDiscordCount(1)).toBe('1 time');
    expect(formatOffDiscordCount(3)).toBe('3 times');
    expect(formatOffDiscordCount(null)).toBe('0 times');
  });
});

const passingVotes = { yes: 10, no: 2, minYesVotes: 10, minYesRate: 0.8, voteAcceptHours: 16 };

describe('evaluateVoteOutcome', () => {
  it('accepts when votes and hours both pass', () => {
    const r = evaluateVoteOutcome({ ...passingVotes, playtimeHours: 16, isTestSteamId: false });
    expect(r.outcome).toBe('accepted');
    expect(r.denyReason).toBeNull();
  });
  it('denies on hours when votes pass', () => {
    const r = evaluateVoteOutcome({ ...passingVotes, playtimeHours: 8.4, isTestSteamId: false });
    expect(r.outcome).toBe('denied');
    expect(r.votesOk).toBe(true);
    expect(r.hoursOk).toBe(false);
    expect(r.denyReason).toBe('The 16-hour in-game requirement was not met.');
  });
  it('denies on votes when hours pass', () => {
    const r = evaluateVoteOutcome({ ...passingVotes, yes: 4, no: 2, playtimeHours: 20, isTestSteamId: false });
    expect(r.outcome).toBe('denied');
    expect(r.denyReason).toBe('The membership vote did not pass.');
  });
  it('uses the combined reason when both fail', () => {
    const r = evaluateVoteOutcome({ ...passingVotes, yes: 4, no: 2, playtimeHours: 5, isTestSteamId: false });
    expect(r.denyReason).toBe(
      'The membership vote did not pass, and the 16-hour in-game requirement was not met.',
    );
  });
  it('skips the hours rule when playtime is missing', () => {
    const r = evaluateVoteOutcome({ ...passingVotes, playtimeHours: null, isTestSteamId: false });
    expect(r.hoursOk).toBe(true);
    expect(r.hoursUnverified).toBe(true);
    expect(r.outcome).toBe('accepted');
  });
  it('skips the hours rule for test steam ids', () => {
    const r = evaluateVoteOutcome({ ...passingVotes, playtimeHours: 1, isTestSteamId: true });
    expect(r.hoursOk).toBe(true);
    expect(r.hoursUnverified).toBe(false);
    expect(r.outcome).toBe('accepted');
  });
  it('uses the configured accept hours in deny copy', () => {
    const r = evaluateVoteOutcome({
      ...passingVotes,
      voteAcceptHours: 20,
      playtimeHours: 8,
      isTestSteamId: false,
    });
    expect(r.denyReason).toBe('The 20-hour in-game requirement was not met.');
  });
});
