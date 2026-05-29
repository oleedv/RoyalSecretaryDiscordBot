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

export async function upsertPersistedRotation({ cleanedText, mode, source }) {
  await query(
    `INSERT INTO layer_rotation_current (id, cleaned_text, mode, source)
     VALUES (1, ?, ?, ?)
     ON DUPLICATE KEY UPDATE cleaned_text = VALUES(cleaned_text), mode = VALUES(mode), source = VALUES(source)`,
    [cleanedText, mode, source]
  );
}
