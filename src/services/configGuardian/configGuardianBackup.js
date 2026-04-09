import { simpleGit } from 'simple-git';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import logger from '../../logger.js';

const log = logger.child({ module: 'configGuardian' });

export async function runBackup(guardian, repoUrl) {
  const tempDir = await mkdtemp(join(tmpdir(), 'cfg-backup-'));
  try {
    const git = simpleGit();
    await git.clone(repoUrl, tempDir, ['--branch', 'master', '--single-branch']);
    const localGit = simpleGit(tempDir);
    await localGit.addConfig('user.name', 'Royal Battalion Bot');
    await localGit.addConfig('user.email', process.env.GIT_AUTHOR_EMAIL || 'bot@royalbattalion.com');
    const buffers = guardian.getAllBuffers();
    for (const [name, content] of buffers) {
      await writeFile(join(tempDir, name), content);
    }
    const status = await localGit.status();
    if (!status.isClean()) {
      await localGit.add('-A');
      const changedFiles = [...status.modified, ...status.not_added, ...status.created, ...status.deleted];
      const msg = changedFiles.length === 1
        ? `Updated ${changedFiles[0]}`
        : `Updated ${changedFiles.length} files:\n${changedFiles.map((f) => `- ${f}`).join('\n')}`;
      await localGit.commit(msg);
      await localGit.push('origin', 'master');
      log.info({ count: changedFiles.length }, 'Backup pushed');
    } else {
      log.debug('Backup: no changes to commit');
    }
  } catch (err) {
    const safeMsg = String(err.message).replace(/https?:\/\/[^@]+@/g, 'https://***@');
    log.error({ err: safeMsg }, 'Backup failed');
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
