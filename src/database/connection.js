import { createPool } from 'mariadb';
import { readFileSync } from 'node:fs';
import config from '../config.js';
import logger from '../logger.js';
import { reportError } from '../services/admin/errorAlertService.js';

const log = logger.child({ module: 'database' });

const pools = {};
const OPTIONAL_POOLS = new Set(['website']);

// Resolve the mariadb `ssl` option from config. Three states:
//   DB_SSL unset/false      -> undefined (plaintext, the internal-docker default)
//   DB_SSL=true + DB_SSL_CA  -> validated TLS (server cert checked against the pinned CA)
//   DB_SSL=true, no CA       -> encrypted but UNVALIDATED (warns; active MITM still possible)
// A CA path that is set but unreadable throws (fail closed) rather than silently
// downgrading to an unvalidated connection.
function buildSslOption() {
  if (!config.database.ssl) return undefined;

  const caPath = config.database.sslCa;
  if (caPath) {
    const ca = readFileSync(caPath, 'utf8');
    return { ca, rejectUnauthorized: config.database.sslRejectUnauthorized };
  }

  log.warn('DB_SSL is on but DB_SSL_CA is not set - the DB connection is encrypted but the server certificate is NOT validated (MITM possible). Set DB_SSL_CA to a CA PEM path to enable validation.');
  return { rejectUnauthorized: false };
}

function createPoolForDb(name, database, ssl) {
  const pool = createPool({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database,
    ssl,
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
  const ssl = buildSslOption(); // throws on a set-but-unreadable DB_SSL_CA -> boot fails loudly
  const { databases } = config.database;
  for (const [name, database] of Object.entries(databases)) {
    if (!database) { log.warn(`Skipping pool "${name}" - no database name configured`); continue; }
    createPoolForDb(name, database, ssl);
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
