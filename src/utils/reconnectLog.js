/**
 * Decide whether a reconnect/outage loop should emit a log line.
 * Always log the first two attempts, then back off so a down host
 * (e.g. staging) does not flood docker / bot logs every few seconds.
 */
export function shouldLogReconnectAttempt(n) {
  if (n <= 2) return true;
  if (n <= 20) return n % 5 === 0;
  if (n <= 100) return n % 20 === 0;
  return n % 50 === 0;
}
