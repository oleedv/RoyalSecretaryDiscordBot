import logger from '../../logger.js';
import { ConfigGuardian } from './configGuardianService.js';
import { runBackup } from './configGuardianBackup.js';
import config from '../../config.js';

const log = logger.child({ module: 'configGuardian' });

let guardian = null;
let pollIntervalId = null;
let backupIntervalId = null;

function getRepoUrl() {
  if (process.env.GIT_REPO_URL) return process.env.GIT_REPO_URL;
  const user = process.env.GIT_USER;
  const token = process.env.GIT_TOKEN;
  if (user && token) return `https://${user}:${token}@github.com/oleedv/rb-cfg-backup.git`;
  return null;
}

async function poll(client) {
  if (!guardian) return;
  try {
    const messages = await guardian.run();
    if (messages.length === 0) return;
    const channelId = config.configGuardian?.channelId;
    if (!channelId) return;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      log.error({ channelId }, 'Config Guardian channel not found');
      return;
    }
    for (const msg of messages) {
      const MAX_EMBEDS = 10;
      if (msg.embeds.length <= MAX_EMBEDS) {
        await channel.send({ embeds: msg.embeds, files: msg.files });
      } else {
        for (let i = 0; i < msg.embeds.length; i += MAX_EMBEDS) {
          const batch = msg.embeds.slice(i, i + MAX_EMBEDS);
          const files = i === 0 ? msg.files : [];
          await channel.send({ embeds: batch, files });
        }
      }
    }
    const repoUrl = getRepoUrl();
    if (repoUrl) await runBackup(guardian, repoUrl);
  } catch (err) {
    log.error({ err }, 'Poll cycle error');
  }
}

async function dailyBackup() {
  if (!guardian) return;
  const repoUrl = getRepoUrl();
  if (!repoUrl) return;
  await runBackup(guardian, repoUrl);
}

export async function startScheduler(client) {
  const sftpHost = process.env.SFTP_HOST;
  const sftpUser = process.env.SFTP_USER;
  const sftpPass = process.env.SFTP_PASS;
  const sftpPath = process.env.SFTP_PATH;
  if (!sftpHost || !sftpUser || !sftpPass || !sftpPath) {
    log.warn('Config Guardian disabled -- missing SFTP environment variables (SFTP_HOST, SFTP_USER, SFTP_PASS, SFTP_PATH)');
    return;
  }
  const channelId = config.configGuardian?.channelId;
  if (!channelId) {
    log.warn('Config Guardian disabled -- no channelId in settings');
    return;
  }
  try {
    guardian = new ConfigGuardian({
      host: sftpHost,
      port: parseInt(process.env.SFTP_PORT || '22', 10),
      user: sftpUser,
      pass: sftpPass,
      path: sftpPath,
    });
    await guardian.init();
    pollIntervalId = setInterval(() => poll(client), 60_000);
    backupIntervalId = setInterval(() => {
      const now = new Date();
      if (now.getUTCHours() === 2 && now.getUTCMinutes() === 45) dailyBackup();
    }, 60_000);
    log.info('Config Guardian started (1-minute polling)');
  } catch (err) {
    log.error({ err }, 'Failed to initialize Config Guardian');
  }
}

export function stopScheduler() {
  if (pollIntervalId) { clearInterval(pollIntervalId); pollIntervalId = null; }
  if (backupIntervalId) { clearInterval(backupIntervalId); backupIntervalId = null; }
  guardian = null;
}
