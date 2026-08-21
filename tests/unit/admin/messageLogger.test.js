import { describe, it, expect } from 'bun:test';
import { buildMessageLogFields } from '../../../src/services/admin/messageLogger.js';

function baseMessage(overrides = {}) {
  return {
    id: 'msg-1',
    guild: { id: 'guild-1' },
    channel: {
      id: 'ch-1',
      name: 'general',
      parentId: 'cat-1',
      isThread: () => false,
    },
    author: { id: 'u-1', tag: 'User#1' },
    content: 'hello',
    attachments: { size: 0, map: () => [] },
    ...overrides,
  };
}

describe('buildMessageLogFields', () => {
  it('logs a normal guild message with parent = the channel itself', () => {
    const row = buildMessageLogFields(baseMessage());
    expect(row.channelId).toBe('ch-1');
    expect(row.channelName).toBe('general');
    expect(row.parentChannelId).toBe('ch-1');
    expect(row.parentChannelName).toBe('general');
    expect(row.threadId).toBe(null);
    expect(row.threadName).toBe(null);
    expect(row.replyToMessageId).toBe(null);
    expect(row.isDm).toBe(false);
  });

  it('logs a Discord thread under its parent channel', () => {
    const row = buildMessageLogFields(baseMessage({
      channel: {
        id: 'thread-9',
        name: 'steam check',
        parentId: 'ch-1',
        parent: { id: 'ch-1', name: 'general' },
        isThread: () => true,
      },
    }));
    expect(row.channelId).toBe('thread-9');
    expect(row.channelName).toBe('steam check');
    expect(row.parentChannelId).toBe('ch-1');
    expect(row.parentChannelName).toBe('general');
    expect(row.threadId).toBe('thread-9');
    expect(row.threadName).toBe('steam check');
  });

  it('captures reply parent id, tag, and a short snippet', () => {
    const row = buildMessageLogFields(baseMessage({
      reference: { messageId: 'parent-1' },
      referencedMessage: {
        author: { tag: 'Staff#2' },
        content: 'Can you join tonight for the match please?',
      },
    }));
    expect(row.replyToMessageId).toBe('parent-1');
    expect(row.replyToTag).toBe('Staff#2');
    expect(row.replyToContent).toBe('Can you join tonight for the match please?');
  });

  it('truncates long reply snippets', () => {
    const row = buildMessageLogFields(baseMessage({
      reference: { messageId: 'parent-1' },
      referencedMessage: { author: { tag: 'A#1' }, content: 'x'.repeat(300) },
    }));
    expect(row.replyToContent.length).toBeLessThanOrEqual(180);
  });

  it('labels DMs without treating them as threads', () => {
    const row = buildMessageLogFields(baseMessage({
      guild: null,
      channel: { id: 'dm-1', name: null, isThread: () => false },
    }));
    expect(row.isDm).toBe(true);
    expect(row.channelName).toBe('DM');
    expect(row.threadId).toBe(null);
    expect(row.parentChannelId).toBe(null);
  });
});
