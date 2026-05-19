import logger from '../../logger.js';
import { createScheduler } from '../../utils/scheduler.js';
import { ConfigGuardian } from './configGuardianService.js';
import { runBackup } from './configGuardianBackup.js';
import config from '../../config.js';
import { reportError } from '../admin/errorAlertService.js';

const log = logger.child({ module: 'configGuardian' });

let guardian = null;
let backupIntervalId = null;
let lastBackupDate = null;

function getRepoUrl() {
  if (process.env.GIT_REPO_URL) return process.env.GIT_REPO_URL;
  const user = process.env.GIT_USER;
  const token = process.env.GIT_TOKEN;
  if (user && token) return `https://${user}:${token}@github.com/oleedv/rb-cfg-backup.git`;
  return null;
}

const MAX_EMBEDS_PER_MESSAGE = 10;
const MAX_TOTAL_EMBED_CHARS = 5800;

function embedCharCount(embed) {
  const data = typeof embed.toJSON === 'function' ? embed.toJSON() : embed;
  let n = 0;
  if (data.title) n += data.title.length;
  if (data.description) n += data.description.length;
  if (data.footer?.text) n += data.footer.text.length;
  if (data.author?.name) n += data.author.name.length;
  if (Array.isArray(data.fields)) {
    for (const f of data.fields) n += (f.name?.length ?? 0) + (f.value?.length ?? 0);
  }
  return n;
}

function batchEmbeds(embeds) {
  const batches = [];
  let current = [];
  let currentChars = 0;
  for (const embed of embeds) {
    const chars = embedCharCount(embed);
    if (current.length >= MAX_EMBEDS_PER_MESSAGE || currentChars + chars > MAX_TOTAL_EMBED_CHARS) {
      if (current.length > 0) batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(embed);
    currentChars += chars;
  }
  if (current.length > 0) batches.push(current);
  return batches;
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
      const batches = batchEmbeds(msg.embeds);
      for (let i = 0; i < batches.length; i++) {
        const files = i === 0 ? msg.files : [];
        await channel.send({ embeds: batches[i], files });
      }
    }
    const repoUrl = getRepoUrl();
    if (repoUrl) await runBackup(guardian, repoUrl);
  } catch (err) {
    log.error({ err }, 'Poll cycle error');
    reportError(err, { source: 'scheduler:configGuardian:poll' }).catch(() => {});
  }
}

async function dailyBackup() {
  if (!guardian) return;
  const today = new Date().toISOString().slice(0, 10);
  if (lastBackupDate === today) return;
  lastBackupDate = today;
  const repoUrl = getRepoUrl();
  if (!repoUrl) return;
  await runBackup(guardian, repoUrl);
}

const pollScheduler = createScheduler({
  name: 'configGuardianPoll',
  intervalMs: 60_000,
  tick: poll,
});

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
    pollScheduler.start(client);
    backupIntervalId = setInterval(() => {
      const now = new Date();
      if (now.getUTCHours() === 2 && now.getUTCMinutes() === 45) dailyBackup();
    }, 60_000);
    log.info('Config Guardian started (1-minute polling)');
  } catch (err) {
    log.error({ err }, 'Failed to initialize Config Guardian');
    reportError(err, { source: 'scheduler:configGuardian:init', severity: 'fatal' }).catch(() => {});
  }
}

export function stopScheduler() {
  pollScheduler.stop();
  if (backupIntervalId) { clearInterval(backupIntervalId); backupIntervalId = null; }
  guardian = null;
}
