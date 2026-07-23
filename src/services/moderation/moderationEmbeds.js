import { EmbedBuilder, AttachmentBuilder } from 'discord.js';

const COLOR_CLEAN = 0x2ECC71;       // Green
const COLOR_POSSIBLE = 0xEBC65D;    // Yellow
const COLOR_DEFINITE = 0xE74C3C;    // Red
const COLOR_ERROR = 0x95A5A6;       // Grey

function fmtTime(d) {
  return new Date(d).toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
}

function topCategories(flags, max = 3) {
  const counts = new Map();
  for (const f of flags) counts.set(f.category, (counts.get(f.category) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([cat, n]) => `${cat} (${n})`)
    .join(', ') || 'none';
}

function quoteBlock(text, indent = '        ') {
  const trimmed = String(text ?? '').replace(/\r/g, '');
  return trimmed.split('\n').map(line => `${indent}> ${line}`).join('\n');
}

function renderFlagSection(flags, header) {
  if (flags.length === 0) return `${header}\n  (none)\n`;
  const lines = [header];
  flags.forEach((f, i) => {
    lines.push(`[${i + 1}] ${f.severity.toUpperCase()}: ${f.category}`);
    lines.push(`    Player:  ${f.player_name}`);
    lines.push(`    Steam:   ${f.steam_id || '(unknown)'}`);
    lines.push(`    EOS:     ${f.eos_id || '(unknown)'}`);
    lines.push(`    Time:    ${fmtTime(f.message_time)}`);
    lines.push(`    Channel: ${f.chat_type}`);
    lines.push(`    Rule:    ${f.rule_cited || '(not cited)'}`);
    lines.push(`    Action:  ${f.recommended_action || '(none suggested)'}`);
    lines.push(`    Message:`);
    lines.push(quoteBlock(f.message_text));
    lines.push(`    Reason:  ${f.ai_reasoning || '(no reasoning given)'}`);
    lines.push('');
  });
  return lines.join('\n');
}

function renderRepeatOffenders(offenders) {
  if (!offenders || offenders.length === 0) return 'REPEAT OFFENDERS (last 30 days, 2+ flags)\n  (none)\n';
  const lines = ['REPEAT OFFENDERS (last 30 days, 2+ flags)'];
  for (const o of offenders) {
    lines.push('');
    lines.push(`${o.player_name} (steam: ${o.steam_id || 'unknown'}, eos: ${o.eos_id || 'unknown'})`);
    if (o.recent && o.recent.length > 0) {
      for (const r of o.recent) {
        const date = new Date(r.run_date).toISOString().slice(0, 10);
        const snippet = String(r.message_text || '').slice(0, 100);
        lines.push(`  - ${date}: ${r.severity}/${r.category}: "${snippet}"`);
      }
    }
    lines.push(`  Total: ${o.total_flags} flag${o.total_flags === 1 ? '' : 's'} (${o.definite_count} definite, ${o.possible_count} possible)`);
  }
  return lines.join('\n');
}

function buildReportTextFile({ runDate, server, stats, definite, possible, repeatOffenders }) {
  const sep = '='.repeat(64);
  const windowEndIso = `${runDate} ${stats.windowEndTime}`;
  return [
    'ROYAL BATTALION DAILY CHAT MODERATION REPORT',
    `Date: ${runDate} (window: ${stats.windowStartIso} → ${windowEndIso} UTC)`,
    `Server: ${server.name} (id=${server.id})`,
    `Total messages: ${stats.totalMessages} | Unique players: ${stats.uniquePlayers}`,
    `Definite: ${definite.length} | Possible: ${possible.length}`,
    '',
    sep,
    renderFlagSection(definite, 'DEFINITE VIOLATIONS (recommended for action)'),
    sep,
    renderFlagSection(possible, 'POSSIBLE VIOLATIONS (review)'),
    sep,
    renderRepeatOffenders(repeatOffenders),
  ].join('\n');
}

export function buildReportPayload({ runDate, server, stats, definite, possible, repeatOffenders, model }) {
  const definiteCount = definite.length;
  const possibleCount = possible.length;
  const color = definiteCount > 0 ? COLOR_DEFINITE : (possibleCount > 0 ? COLOR_POSSIBLE : COLOR_CLEAN);

  const repeatSummary = (repeatOffenders && repeatOffenders.length > 0)
    ? `${repeatOffenders.length} player(s) with 2+ flags`
    : 'None';

  const embed = new EmbedBuilder()
    .setTitle(`Daily Chat Moderation: ${runDate}`)
    .setColor(color)
    .setDescription(`${server.name}\nWindow: 24h ending ${stats.windowEndTime} UTC`)
    .addFields(
      { name: 'Messages analysed', value: String(stats.totalMessages), inline: true },
      { name: 'Unique players', value: String(stats.uniquePlayers), inline: true },
      { name: 'Definite', value: String(definiteCount), inline: true },
      { name: 'Possible', value: String(possibleCount), inline: true },
      { name: 'Top categories', value: topCategories([...definite, ...possible]), inline: true },
      { name: 'Repeat offenders (30d)', value: repeatSummary, inline: true },
    )
    .setFooter({ text: 'Full report attached' })
    .setTimestamp();

  const text = buildReportTextFile({ runDate, server, stats, definite, possible, repeatOffenders });
  const file = new AttachmentBuilder(Buffer.from(text, 'utf-8'), { name: `moderation-report-${runDate}.txt` });

  return { embeds: [embed], files: [file] };
}

export function buildZeroViolationsPayload({ runDate, server, stats, model }) {
  const description = stats.totalMessages === 0
    ? `${server.name}\nNo chat captured in the last 24h; server may have been offline or quiet.`
    : `${server.name}\nWindow: 24h ending ${stats.windowEndTime} UTC\nNo violations flagged.`;

  const embed = new EmbedBuilder()
    .setTitle(`Daily Chat Moderation: ${runDate}`)
    .setColor(COLOR_CLEAN)
    .setDescription(description)
    .addFields(
      { name: 'Messages analysed', value: String(stats.totalMessages), inline: true },
      { name: 'Unique players', value: String(stats.uniquePlayers), inline: true },
      { name: 'Definite', value: '0', inline: true },
      { name: 'Possible', value: '0', inline: true },
    )
    .setTimestamp();

  if (stats.totalMessages === 0) {
    embed.setFooter({ text: 'No AI call made (no chat)' });
  }

  return { embeds: [embed], files: [] };
}

export function buildErrorPayload({ runDate, errorMessage, stage }) {
  const embed = new EmbedBuilder()
    .setTitle(`Daily Chat Moderation: ${runDate} (failed)`)
    .setColor(COLOR_ERROR)
    .setDescription(`Report could not be generated.\nStage: \`${stage}\`\n\n${errorMessage}`)
    .setFooter({ text: 'Will retry on next scheduler tick (up to 3x per day).' })
    .setTimestamp();

  return { embeds: [embed], files: [] };
}
