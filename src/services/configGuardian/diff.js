import { structuredPatch, diffChars } from 'diff';

export const ChangeType = Object.freeze({
  NEW_FILE: 'NEW_FILE',
  ADDITIONS: 'ADDITIONS',
  DELETIONS: 'DELETIONS',
  MIXED: 'MIXED',
  DELETED: 'DELETED',
});

const RESET  = '\x1b[0m';
const ADD    = '\x1b[1;32m';
const DEL    = '\x1b[1;31m';
const UL     = '\x1b[4m';
const UL_OFF = '\x1b[24m';

// Minimum character-similarity (difflib-style ratio) for a deleted/added line
// pair to be treated as an in-place edit and given inline highlighting. Below
// this the two lines are unrelated (e.g. a wholesale-reordered rotation), so we
// render them as a plain removal + addition instead of garbled underline noise.
const SIMILARITY_THRESHOLD = 0.6;

export function inlineHighlight(oldText, newText) {
  const changes = diffChars(oldText, newText);
  let oldHl = '';
  let newHl = '';
  let common = 0;
  for (const part of changes) {
    if (part.added) {
      newHl += `${UL}${part.value}${UL_OFF}`;
    } else if (part.removed) {
      oldHl += `${UL}${part.value}${UL_OFF}`;
    } else {
      oldHl += part.value;
      newHl += part.value;
      common += part.value.length;
    }
  }
  const total = oldText.length + newText.length;
  const similarity = total === 0 ? 1 : (2 * common) / total;
  return { oldHl, newHl, similarity };
}

export function computeDiff(oldContent, newContent, filename) {
  const patch = structuredPatch(`a/${filename}`, `b/${filename}`, oldContent, newContent, undefined, undefined, { context: 3 });
  const plainLines = [];
  plainLines.push(`--- a/${filename}`);
  plainLines.push(`+++ b/${filename}`);
  for (const hunk of patch.hunks) {
    plainLines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) plainLines.push(line);
  }
  const plainDiff = plainLines.join('\n');
  const stats = { added: 0, removed: 0, modified: 0 };
  const ansiLines = [];
  for (const hunk of patch.hunks) {
    const delBlock = [];
    const addBlock = [];
    const flushBlock = () => {
      const pairs = Math.min(delBlock.length, addBlock.length);
      for (let i = 0; i < pairs; i++) {
        const { oldHl, newHl, similarity } = inlineHighlight(delBlock[i], addBlock[i]);
        if (similarity >= SIMILARITY_THRESHOLD) {
          ansiLines.push(`${DEL}-${oldHl}${RESET}`);
          ansiLines.push(`${ADD}+${newHl}${RESET}`);
          stats.modified++;
        } else {
          ansiLines.push(`${DEL}-${delBlock[i]}${RESET}`);
          ansiLines.push(`${ADD}+${addBlock[i]}${RESET}`);
          stats.removed++;
          stats.added++;
        }
      }
      for (let i = pairs; i < delBlock.length; i++) {
        ansiLines.push(`${DEL}-${delBlock[i]}${RESET}`);
        stats.removed++;
      }
      for (let i = pairs; i < addBlock.length; i++) {
        ansiLines.push(`${ADD}+${addBlock[i]}${RESET}`);
        stats.added++;
      }
      delBlock.length = 0;
      addBlock.length = 0;
    };
    for (const line of hunk.lines) {
      if (line.startsWith('-')) {
        if (addBlock.length > 0 && delBlock.length === 0) flushBlock();
        delBlock.push(line.slice(1));
      } else if (line.startsWith('+')) {
        addBlock.push(line.slice(1));
      } else {
        flushBlock();
        const content = line.startsWith(' ') ? line.slice(1) : line;
        ansiLines.push(` ${content}`);
      }
    }
    flushBlock();
  }
  const formatted = ansiLines.join('\n');
  let changeType;
  if (stats.added > 0 && stats.removed === 0 && stats.modified === 0) changeType = ChangeType.ADDITIONS;
  else if (stats.removed > 0 && stats.added === 0 && stats.modified === 0) changeType = ChangeType.DELETIONS;
  else changeType = ChangeType.MIXED;
  return { formatted, plainDiff, stats, changeType };
}

export function chunkDiff(text, maxLen = 3500) {
  if (text.length <= maxLen) return [text];
  const lines = text.split('\n');
  const chunks = [];
  let current = [];
  let length = 0;
  for (const line of lines) {
    const lineLen = line.length + 1;
    if (current.length > 0 && length + lineLen > maxLen) {
      chunks.push(current.join('\n'));
      current = [];
      length = 0;
    }
    current.push(line);
    length += lineLen;
  }
  if (current.length > 0) chunks.push(current.join('\n'));
  return chunks;
}
