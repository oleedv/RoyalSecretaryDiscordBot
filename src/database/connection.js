import mariadb from 'mariadb';
import config from '../config.js';
import logger from '../logger.js';

const log = logger.child({ module: 'database' });

const pools = {};

function createPoolForDb(name, database) {
  const pool = mariadb.createPool({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database,
    connectionLimit: 10,
    idleTimeout: 60000,
  });

  pools[name] = pool;
  log.info(`Connection pool created for "${database}" (as "${name}")`);
  return pool;
}

export function createPools() {
  const { databases } = config.database;
  for (const [name, database] of Object.entries(databases)) {
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

export async function testConnections() {
  for (const [name, pool] of Object.entries(pools)) {
    try {
      const conn = await pool.getConnection();
      await conn.ping();
      conn.release();
      log.info(`Connection verified: ${name}`);
    } catch (err) {
      log.error({ err, pool: name }, 'Connection failed');
      return false;
    }
  }
  return true;
}

export async function closePools() {
  for (const [name, pool] of Object.entries(pools)) {
    await pool.end();
    log.info(`Connection pool closed: ${name}`);
  }
}
