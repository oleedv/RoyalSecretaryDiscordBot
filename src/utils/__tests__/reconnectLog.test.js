import { describe, expect, test } from 'bun:test';
import { shouldLogReconnectAttempt } from '../reconnectLog.js';

describe('shouldLogReconnectAttempt', () => {
  test('logs the first two attempts', () => {
    expect(shouldLogReconnectAttempt(1)).toBe(true);
    expect(shouldLogReconnectAttempt(2)).toBe(true);
  });

  test('throttles a persistent outage', () => {
    expect(shouldLogReconnectAttempt(3)).toBe(false);
    expect(shouldLogReconnectAttempt(5)).toBe(true);
    expect(shouldLogReconnectAttempt(6)).toBe(false);
    expect(shouldLogReconnectAttempt(20)).toBe(true);
    expect(shouldLogReconnectAttempt(21)).toBe(false);
    expect(shouldLogReconnectAttempt(40)).toBe(true);
    expect(shouldLogReconnectAttempt(100)).toBe(true);
    expect(shouldLogReconnectAttempt(150)).toBe(true);
    expect(shouldLogReconnectAttempt(151)).toBe(false);
  });
});
