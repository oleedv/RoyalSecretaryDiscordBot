import { Writable } from 'stream';

const LEVEL_LABELS = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
const FLUSH_INTERVAL = 5000;
const MAX_BATCH = 50;
const MAX_BUFFER = 500;

let buffer = [];
let timer = null;
let _query = null;

async function getQuery() {
  if (!_query) {
    const mod = await import('../../database/connection.js');
    _query = mod.query;
  }
  return _query;
}

async function flush() {
  if (buffer.length === 0) return;
  const batch = buffer.splice(0, MAX_BATCH);

  try {
    const q = await getQuery();
    const placeholders = batch.map(() => '(?, ?, ?, ?, ?)').join(', ');
    const values = batch.flatMap(r => [r.level, r.levelLabel, r.module, r.message, r.data]);
    await q(
      `INSERT INTO bot_logs (level, level_label, module, message, data) VALUES ${placeholders}`,
      values
    );
  } catch {
    // Drop logs silently if DB is unavailable - avoid infinite recursion
  }
}

function scheduleFlush() {
  if (!timer) {
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, FLUSH_INTERVAL);
  }
}

export const dbLogStream = new Writable({
  write(chunk, _encoding, callback) {
    try {
      const obj = JSON.parse(chunk.toString());
      if (obj.level < 30) { callback(); return; }

      const { level, msg, module, err, time, pid, hostname, ...rest } = obj;
      const data = { ...rest };
      if (err) data.err = typeof err === 'object' ? { message: err.message, code: err.code } : String(err);

      if (buffer.length >= MAX_BUFFER) buffer.shift();

      buffer.push({
        level,
        levelLabel: LEVEL_LABELS[level] || 'unknown',
        module: module || null,
        message: msg || '',
        data: Object.keys(data).length > 0 ? JSON.stringify(data) : null,
      });

      if (buffer.length >= MAX_BATCH) flush();
      else scheduleFlush();
    } catch {
      // Ignore parse errors
    }
    callback();
  },
});

export function flushLogs() {
  if (timer) { clearTimeout(timer); timer = null; }
  return flush();
}
