/**
 * Parse text commands used in ticket/prospect channels.
 * Returns { type, content } or null.
 */
export function parseTextCommand(text) {
  const content = text.trim();

  if (content === '!close') {
    return { type: 'close', content: '' };
  }

  const logsMatch = content.match(/^!logs(\d*)$/);
  if (logsMatch) {
    return { type: 'logs', content: logsMatch[1] || '1' };
  }

  if (content === '!r' || content === '!reply' || content.startsWith('!r ') || content.startsWith('!reply ')) {
    let replyContent = '';
    if (content.startsWith('!r ')) replyContent = content.slice(3).trim();
    else if (content.startsWith('!reply ')) replyContent = content.slice(7).trim();
    return { type: 'reply', content: replyContent };
  }

  return null;
}
