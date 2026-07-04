import SftpClient from 'ssh2-sftp-client';
import { createHash } from 'crypto';
import { query } from '../../database/connection.js';

const MODE_LINE = /^\s*MapRotationMode\s*=\s*(\S+)\s*$/;
const COMMENT_PREFIX = /^\s*(\/\/|#)/;

export function parseMapRotationMode(cfgText) {
  if (!cfgText) return null;
  const lines = cfgText.split(/\r?\n/);
  for (const line of lines) {
    if (COMMENT_PREFIX.test(line)) continue;
    const m = line.match(MODE_LINE);
    if (m) return m[1];
  }
  return null;
}

export function parseLayerRotation(cfgText) {
  if (!cfgText) return { cleanedText: '', lines: [] };
  const lines = cfgText
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.length > 0)
    .filter((l) => !COMMENT_PREFIX.test(l));
  return { cleanedText: lines.join('\n'), lines };
}

export async function fetchCfgFiles(sftpConfig, opts) {
  const {
    serverCfgName,
    layerRotationName,
    cachedServerCfgName,
    serverCfgOnly = false,
  } = opts;

  const sftp = new SftpClient('layer-rotation-validator');
  await sftp.connect({
    host: sftpConfig.host,
    port: sftpConfig.port,
    username: sftpConfig.user,
    password: sftpConfig.pass,
    readyTimeout: 30_000,
    retries: 2,
    retry_factor: 1,
    retry_minTimeout: 1_000,
  });
  try {
    const namesToTry = cachedServerCfgName
      ? [cachedServerCfgName]
      : [serverCfgName, serverCfgName.toLowerCase()].filter((v, i, a) => a.indexOf(v) === i);

    let serverCfgBuf = null;
    let resolvedServerCfgName = null;
    for (const name of namesToTry) {
      try {
        serverCfgBuf = await sftp.get(`${sftpConfig.path}/${name}`);
        resolvedServerCfgName = name;
        break;
      } catch (err) {
        if (!/no such file/i.test(err?.message || '')) throw err;
      }
    }
    if (!serverCfgBuf) {
      throw new Error(`Server cfg not found (tried: ${namesToTry.join(', ')})`);
    }

    if (serverCfgOnly) {
      return {
        serverCfgText: serverCfgBuf.toString('utf-8'),
        layerRotationText: null,
        resolvedServerCfgName,
      };
    }

    const layerRotationBuf = await sftp.get(`${sftpConfig.path}/${layerRotationName}`);
    return {
      serverCfgText: serverCfgBuf.toString('utf-8'),
      layerRotationText: layerRotationBuf.toString('utf-8'),
      resolvedServerCfgName,
    };
  } finally {
    await sftp.end().catch(() => {});
  }
}

export async function validateRotation(squadUtilsUrl, cleanedText) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const resp = await fetch(squadUtilsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rotation: cleanedText }),
      signal: ctrl.signal,
    });
    if (resp.status !== 200 && resp.status !== 422) {
      return { ok: false, errors: null, fetchError: `HTTP ${resp.status}` };
    }
    const data = await resp.json().catch(() => null);
    if (!data) return { ok: false, errors: null, fetchError: 'invalid JSON' };
    const errors = Array.isArray(data.errors) ? data.errors : [];
    return { ok: errors.length === 0, errors };
  } catch (err) {
    const msg = err?.name === 'AbortError' ? 'timeout' : err?.message || 'unknown';
    return { ok: false, errors: null, fetchError: msg };
  } finally {
    clearTimeout(timer);
  }
}

export function hashRotation(mode, cleanedText) {
  return createHash('sha1').update(`${mode}\n${cleanedText}`).digest('hex');
}

export function hashErrors(errors) {
  const safe = Array.isArray(errors) ? errors : [];
  const norm = safe.map((e) => `${e.line}|${e.content}|${e.error}`).sort().join('\n');
  return createHash('sha1').update(norm).digest('hex');
}

export async function readPersistedRotation() {
  const rows = await query(
    'SELECT cleaned_text, mode, source FROM layer_rotation_current WHERE id = 1 LIMIT 1'
  );
  if (!rows || rows.length === 0) return null;
  const row = rows[0];
  if (typeof row.cleaned_text !== 'string' || typeof row.mode !== 'string') return null;
  return {
    cleanedText: row.cleaned_text,
    mode: row.mode,
    source: row.source,
  };
}

// Persist the current rotation and return its updated_at as unix seconds. The
// embed's "Updated" line uses this so it reflects when the rotation LINES last
// changed, not when the embed was last re-rendered. updated_at is advanced
// explicitly here (not left to the column's ON UPDATE CURRENT_TIMESTAMP) so it is
// keyed solely on cleaned_text: bumped to now when the lines differ, otherwise kept.
// This means re-posts with identical lines (NEW_GAME, boot restore, /commands) and
// mode/source-only changes do NOT move the timestamp.
//
// Assignment order matters: `updated_at` must be assigned BEFORE `cleaned_text` in
// the ON DUPLICATE KEY UPDATE list so the `cleaned_text = VALUES(cleaned_text)`
// comparison reads the OLD stored value. (MariaDB evaluates the list left-to-right;
// a column referenced after it was reassigned yields the new value.) Verified against
// MariaDB 12.2. Returns { updatedAt: null } if the timestamp can't be read.
export async function upsertPersistedRotation({ cleanedText, mode, source }) {
  await query(
    `INSERT INTO layer_rotation_current (id, cleaned_text, mode, source)
     VALUES (1, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       updated_at = IF(cleaned_text = VALUES(cleaned_text), updated_at, CURRENT_TIMESTAMP),
       cleaned_text = VALUES(cleaned_text),
       mode = VALUES(mode),
       source = VALUES(source)`,
    [cleanedText, mode, source]
  );
  const rows = await query(
    'SELECT UNIX_TIMESTAMP(updated_at) AS updated_at FROM layer_rotation_current WHERE id = 1 LIMIT 1'
  );
  const ts = rows?.[0]?.updated_at;
  return { updatedAt: ts != null ? Number(ts) : null };
}

export async function readPersistedErrorHash() {
  const rows = await query(
    'SELECT last_error_hash FROM layer_rotation_current WHERE id = 1 LIMIT 1'
  );
  if (!rows || rows.length === 0) return null;
  const value = rows[0].last_error_hash;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// `updated_at = updated_at` keeps the rotation's load time from being bumped by an
// error-hash write. Without it, changing last_error_hash is a real row change that
// fires ON UPDATE CURRENT_TIMESTAMP, so a later re-post of the unchanged rotation
// would show the error time as "Updated" instead of the true load time.
export async function writePersistedErrorHash(hash) {
  await query(
    `INSERT INTO layer_rotation_current (id, cleaned_text, mode, source, last_error_hash)
     VALUES (1, '', 'Unknown', 'sftp', ?)
     ON DUPLICATE KEY UPDATE last_error_hash = VALUES(last_error_hash), updated_at = updated_at`,
    [hash]
  );
}
