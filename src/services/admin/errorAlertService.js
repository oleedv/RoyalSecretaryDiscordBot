import { EmbedBuilder } from 'discord.js';
import config from '../../config.js';
import logger from '../../logger.js';
import { shouldLogReconnectAttempt } from '../../utils/reconnectLog.js';

const log = logger.child({ module: 'errorAlertService' });

const SEVERITY = {
  fatal: { color: 0xed4245, tag: 'FATAL' },
  error: { color: 0xe67e22, tag: 'ERROR' },
  warn:  { color: 0xf1c40f, tag: 'WARN'  },
};

let client = null;
let channelId = null;
let dedupeWindowMs = 60000;
const recent = new Map();

export function init(discordClient) {
  client = discordClient;
  channelId = config.alerts?.channelId || null;
  dedupeWindowMs = config.alerts?.dedupeWindowMs ?? 60000;
  if (!channelId) log.warn('No config.alerts.channelId set; error alerts will only be logged locally.');
}

export async function reportError(err, ctx = {}) {
  const severity = SEVERITY[ctx.severity] ? ctx.severity : 'error';
  const source = ctx.source || 'unknown';

  const key = `${source}::${err?.name || 'Error'}::${(err?.message || '').split('\n')[0]}`;
  const now = Date.now();
  const entry = recent.get(key);
  const rolling = entry && now - (entry.lastSeen ?? entry.firstSeen) < dedupeWindowMs;
  const nextCount = rolling ? entry.count + 1 : 1;

  if (!rolling || shouldLogReconnectAttempt(nextCount)) {
    logger.child({ module: source })[severity]({ err, ...stripEmbedContext(ctx) }, err?.message || 'Error');
  }

  if (rolling) {
    entry.count = nextCount;
    entry.lastSeen = now;
    scheduleExpire(key);
  }

  if (!client || !channelId) {
    if (!rolling) {
      recent.set(key, { count: 1, firstSeen: now, lastSeen: now, messageId: null });
      scheduleExpire(key);
    }
    return;
  }

  // Roll up while the same error is still firing. A new Discord message is
  // only posted after `dedupeWindowMs` of silence, so a down env does not
  // spam the alerts channel every minute.
  if (rolling) {
    if (entry.messageId && shouldLogReconnectAttempt(entry.count)) {
      try {
        const channel = await client.channels.fetch(channelId).catch((fetchErr) => {
          log.warn({ err: fetchErr, channelId }, 'Failed to fetch alert channel for dedupe edit');
          return null;
        });
        const msg = channel ? await channel.messages.fetch(entry.messageId).catch((fetchErr) => {
          log.warn({ err: fetchErr, messageId: entry.messageId }, 'Failed to fetch alert message for dedupe edit');
          return null;
        }) : null;
        if (msg) {
          const orig = msg.embeds[0];
          if (orig) {
            const updated = EmbedBuilder.from(orig).setTitle(`${baseTitle(orig.title)} (x${entry.count})`);
            await msg.edit({ embeds: [updated] }).catch((editErr) => {
              log.warn({ err: editErr, messageId: entry.messageId }, 'Failed to edit alert dedupe count');
            });
          }
        }
      } catch (dedupeErr) {
        log.warn({ err: dedupeErr }, 'Alert dedupe block threw');
      }
    }
    return;
  }

  const channel = await client.channels.fetch(channelId).catch((fetchErr) => {
    log.error({ err: fetchErr, channelId }, 'Failed to fetch alert channel - error alerts will not post');
    return null;
  });
  if (!channel) return;

  const embed = buildErrorEmbed(err, ctx, severity);
  const sent = await channel.send({ embeds: [embed] }).catch((sendErr) => {
    log.error({ err: sendErr, channelId }, 'Failed to send error alert to channel');
    return null;
  });

  const record = { count: 1, firstSeen: now, lastSeen: now, messageId: sent?.id || null };
  recent.set(key, record);
  scheduleExpire(key);
}

function scheduleExpire(key) {
  const entry = recent.get(key);
  if (!entry) return;
  if (entry.expireTimer) clearTimeout(entry.expireTimer);
  entry.expireTimer = setTimeout(() => recent.delete(key), dedupeWindowMs);
  entry.expireTimer.unref?.();
}

export async function postStartupNotice({ env, commit, bootMs, commandCount, eventCount }) {
  if (!client || !channelId) return;
  if (!config.alerts?.startupNotice) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;
  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(`Bot online - ${env || 'unknown'}`)
    .addFields(
      { name: 'Commit', value: commit || 'unknown', inline: true },
      { name: 'Boot time', value: `${bootMs}ms`, inline: true },
      { name: 'Commands', value: String(commandCount ?? '?'), inline: true },
      { name: 'Events', value: String(eventCount ?? '?'), inline: true },
    )
    .setFooter({ text: 'Royal Secretary' })
    .setTimestamp();
  await channel.send({ embeds: [embed] }).catch(() => {});
}

export async function postShutdownNotice({ signal, uptimeMs }) {
  if (!client || !channelId) return;
  if (!config.alerts?.shutdownNotice) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;
  const embed = new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle(`Bot shutting down - ${signal || 'unknown'}`)
    .addFields({ name: 'Uptime', value: formatDuration(uptimeMs), inline: true })
    .setFooter({ text: 'Royal Secretary' })
    .setTimestamp();
  await channel.send({ embeds: [embed] }).catch(() => {});
}

function buildErrorEmbed(err, ctx, severity) {
  const { color, tag } = SEVERITY[severity];
  const source = ctx.source || 'unknown';
  const name = err?.name || 'Error';
  const message = err?.message || String(err);

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`[${tag}] ${name} in ${source}`)
    .setDescription(truncate(message, 1500))
    .setFooter({ text: 'Royal Secretary' })
    .setTimestamp();

  const fields = [];
  fields.push({ name: 'Source', value: source, inline: true });
  fields.push({ name: 'Env', value: process.env.NODE_ENV || 'unknown', inline: true });
  if (ctx.userId) {
    const tagStr = ctx.userTag ? ` (${ctx.userTag})` : '';
    fields.push({ name: 'User', value: `<@${ctx.userId}> \`${ctx.userId}\`${tagStr}`, inline: false });
  }
  if (ctx.guildId || ctx.channelId) {
    const parts = [];
    if (ctx.guildId) parts.push(`guild \`${ctx.guildId}\``);
    if (ctx.channelId) parts.push(`channel <#${ctx.channelId}>`);
    fields.push({ name: 'Location', value: parts.join(' - '), inline: false });
  }
  if (ctx.customId) fields.push({ name: 'customId', value: `\`${ctx.customId}\``, inline: false });
  if (err?.stack) fields.push({ name: 'Stack', value: '```' + truncate(err.stack, 1000) + '```', inline: false });

  embed.addFields(fields);
  return embed;
}

function baseTitle(title) {
  return (title || '').replace(/\s*\(x\d+\)$/, '');
}

function truncate(str, max) {
  if (!str) return '';
  const s = String(str);
  return s.length <= max ? s : s.slice(0, max - 3) + '...';
}

function formatDuration(ms) {
  if (!ms || ms < 0) return 'unknown';
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function stripEmbedContext(ctx) {
  const { err: _e, ...rest } = ctx;
  return rest;
}
