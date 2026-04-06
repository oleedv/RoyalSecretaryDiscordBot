import SftpClient from 'ssh2-sftp-client';
import logger from '../../logger.js';
import { maskSensitiveValues } from './sensitive.js';
import { computeDiff, ChangeType } from './diff.js';
import { buildEmbedMessage } from './configGuardianEmbeds.js';

const log = logger.child({ module: 'configGuardian' });
const ANSI_ADD   = '\x1b[1;32m';
const ANSI_RESET = '\x1b[0m';

export class ConfigGuardian {
  constructor(sftpConfig) {
    this.sftpConfig = sftpConfig;
    this.remotePath = sftpConfig.path;
    this.lastModified = new Map();
    this.lastBuffer = new Map();
    this.knownFiles = new Set();
  }

  async createConnection() {
    const sftp = new SftpClient('config-guardian');
    await sftp.connect({
      host: this.sftpConfig.host,
      port: this.sftpConfig.port,
      username: this.sftpConfig.user,
      password: this.sftpConfig.pass,
      readyTimeout: 30_000,
      retries: 3,
      retry_factor: 1,
      retry_minTimeout: 1_000,
    });
    return sftp;
  }

  async init() {
    const sftp = await this.createConnection();
    try {
      const files = await this.listRegularFiles(sftp);
      for (const file of files) {
        try {
          const content = await sftp.get(this.remote(file.name));
          this.lastModified.set(file.name, file.modifyTime);
          this.lastBuffer.set(file.name, content);
          this.knownFiles.add(file.name);
        } catch (err) {
          log.warn({ err, file: file.name }, 'Skipping file during init');
        }
      }
      log.info(`Initialized -- cached ${this.knownFiles.size} files`);
    } finally {
      await sftp.end();
    }
  }

  async run() {
    const results = [];
    let sftp = null;
    try {
      sftp = await this.createConnection();
      const files = await this.listRegularFiles(sftp);
      const currentFiles = new Set();
      for (const file of files) {
        currentFiles.add(file.name);
        try {
          await this.processFile(sftp, file, results);
        } catch (err) {
          log.warn({ err, file: file.name }, 'Error processing file');
        }
      }
      for (const known of this.knownFiles) {
        if (!currentFiles.has(known)) {
          const oldBuf = this.lastBuffer.get(known);
          const totalLines = oldBuf ? oldBuf.toString('utf-8').split('\n').length : 0;
          results.push({
            filename: known, changeType: ChangeType.DELETED,
            added: 0, removed: totalLines, modified: 0, totalLines,
            diffText: '', plainDiff: '',
            oldSize: oldBuf?.length ?? 0, newSize: 0, maskCount: 0,
          });
          this.lastModified.delete(known);
          this.lastBuffer.delete(known);
        }
      }
      this.knownFiles = currentFiles;
    } catch (err) {
      log.error({ err }, 'Poll cycle failed');
    } finally {
      if (sftp) await sftp.end().catch(() => {});
    }
    if (results.length === 0) return [];
    return results.map((r) => buildEmbedMessage(r));
  }

  getAllBuffers() { return this.lastBuffer; }

  remote(name) { return `${this.remotePath}/${name}`; }

  async listRegularFiles(sftp) {
    const listing = await sftp.list(this.remotePath);
    return listing.filter((f) => f.type === '-');
  }

  async processFile(sftp, file, results) {
    const prevMtime = this.lastModified.get(file.name);
    if (prevMtime === undefined) {
      const content = await sftp.get(this.remote(file.name));
      this.lastModified.set(file.name, file.modifyTime);
      this.lastBuffer.set(file.name, content);
      const text = content.toString('utf-8');
      const allLines = text.split('\n');
      const { masked, maskCount } = maskSensitiveValues(allLines);
      const preview = masked.length <= 40 ? masked : masked.slice(0, 25);
      const body = preview.map((ln) => `${ANSI_ADD}+${ln}${ANSI_RESET}`).join('\n');
      const suffix = masked.length > preview.length ? `\n... ${masked.length - preview.length} more lines` : '';
      results.push({
        filename: file.name, changeType: ChangeType.NEW_FILE,
        added: allLines.length, removed: 0, modified: 0, totalLines: allLines.length,
        diffText: body + suffix, plainDiff: allLines.map((l) => `+${l}`).join('\n'),
        oldSize: 0, newSize: content.length, maskCount,
      });
      return;
    }
    if (prevMtime === file.modifyTime) return;
    const newContent = await sftp.get(this.remote(file.name));
    const oldContent = this.lastBuffer.get(file.name) ?? Buffer.alloc(0);
    this.lastModified.set(file.name, file.modifyTime);
    if (oldContent.equals(newContent)) return;
    this.lastBuffer.set(file.name, newContent);
    const oldLines = oldContent.toString('utf-8').split('\n');
    const newLines = newContent.toString('utf-8').split('\n');
    const oldMasked = maskSensitiveValues(oldLines);
    const newMasked = maskSensitiveValues(newLines);
    const maskCount = Math.max(oldMasked.maskCount, newMasked.maskCount);
    const diff = computeDiff(oldMasked.masked.join('\n'), newMasked.masked.join('\n'), file.name);
    results.push({
      filename: file.name, changeType: diff.changeType,
      added: diff.stats.added, removed: diff.stats.removed, modified: diff.stats.modified,
      totalLines: 0, diffText: diff.formatted, plainDiff: diff.plainDiff,
      oldSize: oldContent.length, newSize: newContent.length, maskCount,
    });
  }
}
