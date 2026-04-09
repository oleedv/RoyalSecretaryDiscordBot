import logger from '../logger.js';

export function createScheduler({ name, intervalMs, tick }) {
  const log = logger.child({ module: name });
  let intervalId = null;
  let running = false;

  return {
    start(client) {
      if (intervalId) return;
      log.info(`Starting ${name} (${intervalMs}ms interval)`);
      intervalId = setInterval(async () => {
        if (running) return;
        running = true;
        try { await tick(client); }
        catch (err) { log.error({ err }, `${name} tick failed`); }
        finally { running = false; }
      }, intervalMs);
      // Initial tick
      tick(client).catch(err => log.error({ err }, `${name} initial tick failed`));
    },
    stop() {
      if (!intervalId) return;
      clearInterval(intervalId);
      intervalId = null;
      log.info(`Stopped ${name}`);
    },
    isActive() { return !!intervalId; },
  };
}
