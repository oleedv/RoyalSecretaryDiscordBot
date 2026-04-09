/**
 * Format a duration in seconds to a human-readable string.
 * Examples: "45s", "12m", "2h 5m"
 */
export function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * Format a date value to ISO date string (YYYY-MM-DD).
 * Returns 'N/A' if the value is falsy.
 */
export function formatDate(d) {
  return d ? new Date(d).toISOString().slice(0, 10) : 'N/A';
}
