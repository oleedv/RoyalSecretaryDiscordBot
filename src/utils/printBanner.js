import { execSync } from 'node:child_process';
import os from 'node:os';
import config from '../config.js';

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  gold: '\x1b[38;5;220m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  white: '\x1b[37m',
};

const LOGO = [
  '  ██████╗  ██████╗ ██╗   ██╗ █████╗ ██╗     ',
  '  ██╔══██╗██╔═══██╗╚██╗ ██╔╝██╔══██╗██║     ',
  '  ██████╔╝██║   ██║ ╚████╔╝ ███████║██║     ',
  '  ██╔══██╗██║   ██║  ╚██╔╝  ██╔══██║██║     ',
  '  ██║  ██║╚██████╔╝   ██║   ██║  ██║███████╗',
  '  ╚═╝  ╚═╝ ╚═════╝    ╚═╝   ╚═╝  ╚═╝╚══════╝',
  '  ██████╗  █████╗ ████████╗████████╗ █████╗ ██╗     ██╗ ██████╗ ███╗   ██╗',
  '  ██╔══██╗██╔══██╗╚══██╔══╝╚══██╔══╝██╔══██╗██║     ██║██╔═══██╗████╗  ██║',
  '  ██████╔╝███████║   ██║      ██║   ███████║██║     ██║██║   ██║██╔██╗ ██║',
  '  ██╔══██╗██╔══██║   ██║      ██║   ██╔══██║██║     ██║██║   ██║██║╚██╗██║',
  '  ██████╔╝██║  ██║   ██║      ██║   ██║  ██║███████╗██║╚██████╔╝██║ ╚████║',
  '  ╚═════╝ ╚═╝  ╚═╝   ╚═╝      ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝ ╚═════╝ ╚═╝  ╚═══╝',
];

const TIPS = [
  'Reload slash commands with `bun run deploy-commands`.',
  'Support tickets are DM-based — users just message the bot directly.',
  'Prospect voting uses reactions on a scheduled embed (see services/prospect/).',
  'Seeding notifications ride a socket.io link to SquadJS — check seedingSocket.js if flaky.',
  'Handler routing lives in handlers/interactionCreate.js — map new customIds there.',
  'Two DB pools: `secretary` (default, full CRUD) and `squadjs` (read-only game data).',
  'Use logger.child({ module: "X" }) — never reach for console.log.',
  'Timed tasks register stopScheduler() hooks — add yours to index.js shutdown.',
  'Commands/events auto-load from their directories — just drop a .js file in.',
  'Guild-scoped command deploys are instant; global deploys take up to an hour.',
];

function getGitInfo() {
  const envCommit = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT;
  const envBranch = process.env.RAILWAY_GIT_BRANCH || process.env.GIT_BRANCH;
  if (envCommit) return { commit: envCommit.slice(0, 7), branch: envBranch || null };
  try {
    const commit = execSync('git rev-parse --short HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 500,
    }).trim();
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 500,
    }).trim();
    return { commit, branch };
  } catch {
    return { commit: null, branch: null };
  }
}

function envTag(env) {
  const up = (env || 'development').toUpperCase();
  if (up.startsWith('PROD')) return `${C.red}${C.bold}[ ${up} ]${C.reset}`;
  if (up.startsWith('STAG')) return `${C.yellow}${C.bold}[ ${up} ]${C.reset}`;
  return `${C.green}${C.bold}[ ${up} ]${C.reset}`;
}

function pickTip() {
  return TIPS[Math.floor(Math.random() * TIPS.length)];
}

function label(text) {
  return `${C.gray}${text.padEnd(9)}${C.reset}`;
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000) % 60;
  const m = Math.floor(ms / 60000) % 60;
  const h = Math.floor(ms / 3600000);
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

export function printStartupBanner() {
  const git = getGitInfo();
  const runtime = typeof Bun !== 'undefined' ? `Bun ${Bun.version}` : `Node ${process.version}`;
  const env = process.env.NODE_ENV || 'development';
  const version = config.bot?.version || 'unknown';
  const name = config.bot?.name || 'Royal Secretary';

  const out = [''];
  for (const row of LOGO) out.push(`${C.gold}${row}${C.reset}`);
  out.push('');
  out.push(`        ${C.bold}${C.white}── ${name} · Discord Bot ──${C.reset}`);
  out.push('');
  out.push(`  ${label('Version')} ${C.white}${version}${C.reset}`);
  out.push(`  ${label('Env')} ${envTag(env)}`);
  out.push(`  ${label('Runtime')} ${runtime} ${C.dim}· ${os.platform()} ${os.release()}${C.reset}`);
  if (git.commit) {
    const br = git.branch ? ` ${C.dim}(${git.branch})${C.reset}` : '';
    out.push(`  ${label('Commit')} ${C.cyan}${git.commit}${C.reset}${br}`);
  }
  out.push(`  ${label('PID')} ${process.pid}`);
  out.push(`  ${label('Started')} ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`);
  out.push('');
  out.push(`  ${C.gold}►${C.reset} ${C.dim}${pickTip()}${C.reset}`);
  out.push('');

  process.stdout.write(out.join('\n') + '\n');
}

export function printReadyBanner({ client, commandCount, eventCount, dbStatus, bootMs }) {
  const out = [''];
  out.push(`  ${C.green}${C.bold}✓ READY${C.reset}  ${C.dim}boot ${bootMs}ms${C.reset}`);
  if (client?.user) {
    out.push(`  ${label('Logged')} ${C.cyan}${client.user.tag}${C.reset} ${C.dim}(${client.user.id})${C.reset}`);
    out.push(`  ${label('Guilds')} ${client.guilds.cache.size}`);
  }
  if (typeof commandCount === 'number') out.push(`  ${label('Commands')} ${commandCount}`);
  if (typeof eventCount === 'number') out.push(`  ${label('Events')} ${eventCount}`);
  if (dbStatus) {
    for (const [name, ok] of Object.entries(dbStatus)) {
      const mark = ok ? `${C.green}ok${C.reset}` : `${C.red}fail${C.reset}`;
      out.push(`  ${label('DB:' + name)} ${mark}`);
    }
  }
  out.push('');
  process.stdout.write(out.join('\n') + '\n');
}

export function printShutdownBanner(signal, startedAt) {
  const uptime = formatUptime(Date.now() - startedAt);
  const name = config.bot?.name || 'Royal Secretary';
  process.stdout.write(
    `\n  ${C.gold}${name}${C.reset} — signing off on ${C.yellow}${signal}${C.reset} ${C.dim}(uptime ${uptime})${C.reset}\n\n`
  );
}
