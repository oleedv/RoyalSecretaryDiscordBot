import { createPool } from 'mariadb';
import config from '../config.js';
import logger from '../logger.js';
import { reportError } from '../services/admin/errorAlertService.js';

const log = logger.child({ module: 'database' });

const pools = {};
const OPTIONAL_POOLS = new Set(['website']);

function createPoolForDb(name, database) {
  const pool = createPool({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database,
    ssl: config.database.ssl ? { rejectUnauthorized: false } : undefined,
    connectionLimit: 10,
    idleTimeout: 60000,
    acquireTimeout: 10000,
    connectTimeout: 10000,
  });

  if (typeof pool.on === 'function') {
    pool.on('error', (err) => {
      reportError(err, { source: `dbPool:${name}`, severity: 'error' }).catch(() => {});
    });
  }

  pools[name] = pool;
  log.info(`Connection pool created for "${database}" (as "${name}")`);
  return pool;
}

export function createPools() {
  const { databases } = config.database;
  for (const [name, database] of Object.entries(databases)) {
    if (!database) { log.warn(`Skipping pool "${name}" - no database name configured`); continue; }
    createPoolForDb(name, database);
  }
}

export function getPool(name = 'secretary') {
  const pool = pools[name];
  if (!pool) {
    throw new Error(`Database pool "${name}" not found. Available: ${Object.keys(pools).join(', ')}`);
  }
  return pool;
}

export async function query(sql, params, poolName = 'secretary') {
  const conn = await getPool(poolName).getConnection();
  try {
    return await conn.query(sql, params);
  } finally {
    conn.release();
  }
}

export async function transaction(fn, poolName = 'secretary') {
  const conn = await getPool(poolName).getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function testConnections() {
  const status = {};
  let ok = true;
  for (const [name, pool] of Object.entries(pools)) {
    try {
      const conn = await pool.getConnection();
      await conn.ping();
      conn.release();
      log.info(`Connection verified: ${name}`);
      status[name] = true;
    } catch (err) {
      status[name] = false;
      if (OPTIONAL_POOLS.has(name)) {
        log.warn({ err, pool: name }, 'Optional connection failed - features using this pool will be disabled');
        delete pools[name];
        continue;
      }
      log.error({ err, pool: name }, 'Connection failed');
      ok = false;
    }
  }
  return { ok, status };
}

export async function closePools() {
  for (const [name, pool] of Object.entries(pools)) {
    await pool.end();
    log.info(`Connection pool closed: ${name}`);
  }
}
