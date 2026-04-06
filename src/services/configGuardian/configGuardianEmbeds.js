import { EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { ChangeType, chunkDiff } from './diff.js';

const COLORS = {
  [ChangeType.NEW_FILE]:   0x3498DB,
  [ChangeType.ADDITIONS]:  0x2ECC71,
  [ChangeType.DELETIONS]:  0xE74C3C,
  [ChangeType.MIXED]:      0xEBC65D,
  [ChangeType.DELETED]:    0x95A5A6,
};

const TITLE_PREFIX = {
  [ChangeType.NEW_FILE]:   'New file:',
  [ChangeType.ADDITIONS]:  'Added to',
  [ChangeType.DELETIONS]:  'Removed from',
  [ChangeType.MIXED]:      'Changed in',
  [ChangeType.DELETED]:    'Deleted:',
};

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatSizeDelta(oldSize, newSize) {
  const delta = newSize - oldSize;
  const sign = delta >= 0 ? '+' : '';
  return `${formatBytes(newSize)} (${sign}${delta} bytes)`;
}

function buildStatsValue(result) {
  const parts = [];
  if (result.added > 0)    parts.push(`+${result.added} added`);
  if (result.removed > 0)  parts.push(`-${result.removed} removed`);
  if (result.modified > 0) parts.push(`~${result.modified} modified`);
  if (result.changeType === ChangeType.NEW_FILE)  parts.push(`${result.totalLines} lines`);
  if (result.changeType === ChangeType.DELETED)    parts.push(`${result.totalLines} lines removed`);
  return parts.join(', ');
}

export function buildEmbedMessage(result) {
  const color = COLORS[result.changeType];
  const title = `${TITLE_PREFIX[result.changeType]} ${result.filename}`;
  const statsValue = buildStatsValue(result);
  const footer = result.maskCount > 0 ? `${result.maskCount} value(s) masked` : null;
  const embeds = [];
  const files = [];

  if (result.changeType === ChangeType.DELETED) {
    const embed = new EmbedBuilder()
      .setTitle(title).setColor(color)
      .setDescription('File was removed from the server.')
      .addFields({ name: 'Removed', value: statsValue, inline: true })
      .setTimestamp();
    if (footer) embed.setFooter({ text: footer });
    embeds.push(embed);
    return { embeds, files };
  }

  const sizeValue = result.changeType === ChangeType.NEW_FILE
    ? formatBytes(result.newSize)
    : formatSizeDelta(result.oldSize, result.newSize);

  const chunks = chunkDiff(result.diffText, 3500);
  if (chunks.length > 1) {
    files.push(new AttachmentBuilder(Buffer.from(result.plainDiff, 'utf-8'), { name: `${result.filename}.diff` }));
  }

  for (let i = 0; i < chunks.length; i++) {
    const partLabel = chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : '';
    const embed = new EmbedBuilder()
      .setTitle(`${title}${partLabel}`).setColor(color)
      .setDescription(`\`\`\`ansi\n${chunks[i]}\n\`\`\``)
      .setTimestamp();
    if (i === 0) {
      embed.addFields(
        { name: 'Change', value: statsValue, inline: true },
        { name: 'Size', value: sizeValue, inline: true },
      );
    }
    if (footer) embed.setFooter({ text: footer });
    embeds.push(embed);
  }

  return { embeds, files };
}
