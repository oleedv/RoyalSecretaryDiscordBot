export async function safeFetch(url, { timeout = 10_000, label = 'fetch', logger } = {}) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    if (!res.ok) {
      logger?.warn({ status: res.status, label }, `${label}: HTTP ${res.status}`);
      return null;
    }
    return res;
  } catch (err) {
    logger?.error({ err: err.message, label }, `${label} failed`);
    return null;
  }
}
